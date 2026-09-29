import { getSessionUser } from "@/lib/session";
import { verifyPin } from "@/lib/pin";
import { clearPinFailures, pinRetryAfter, recordPinFailure } from "@/lib/rate-limit";
import { signWalletUnlock, WALLET_UNLOCK_COOKIE, WALLET_UNLOCK_TTL } from "@/lib/session-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Verify the wallet PIN once and issue a short-lived unlock cookie so sends
// within the next few minutes don't re-prompt.
//
// THE PIN IS FOUR DIGITS AND THIS COOKIE SPENDS MONEY. What it unlocks is
// /api/wallet/send, /api/debts/[id]/pay, the bill claim and refund legs and the
// key export — so without a limit here, a caller holding a session could walk all
// 10,000 candidates and drain the wallet. The session alone is NOT the barrier
// this is behind: the PIN exists precisely because a hijacked social login should
// not be enough, which means the count has to be durable and shared across
// instances rather than kept in one lambda's memory. See lib/rate-limit.ts.
//
// The delay is served BEFORE the PIN is read, and reading it does not extend the
// delay — otherwise a locked-out user could never wait one out.
function retryResponse(retryAfterMs: number) {
  const seconds = Math.ceil(retryAfterMs / 1000);
  return Response.json(
    {
      error:
        seconds > 3600
          ? `Too many incorrect PINs. Try again in ${Math.ceil(seconds / 3600)} hours.`
          : `Too many incorrect PINs. Try again in ${Math.ceil(seconds / 60)} minutes.`,
      retryAfterSeconds: seconds,
    },
    { status: 429, headers: { "Retry-After": String(seconds) } },
  );
}

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) {
    return Response.json({ error: "Not signed in" }, { status: 401 });
  }
  if (!user.pin_hash) {
    return Response.json({ error: "No PIN set" }, { status: 409 });
  }

  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    return Response.json({ error: "Server not configured" }, { status: 500 });
  }

  const waiting = await pinRetryAfter(user.id);
  if (waiting > 0) return retryResponse(waiting);

  const body = (await request.json().catch(() => null)) as { pin?: unknown } | null;
  const pin = String(body?.pin ?? "");
  if (!verifyPin(pin, user.pin_hash)) {
    // Counted BEFORE the answer goes out, so a caller cannot outrun the record by
    // hanging up. The wait is reported rather than hidden: a real user who
    // mistyped needs to know when to come back, and an attacker learns only the
    // schedule, which is published in lib/rate-limit.ts anyway.
    const retryAfter = await recordPinFailure(user.id);
    if (retryAfter > 0) return retryResponse(retryAfter);
    return Response.json({ error: "Incorrect PIN." }, { status: 403 });
  }

  // A correct PIN forgets the failures before it, so a day of fat-fingering does
  // not follow someone who then gets it right.
  await clearPinFailures(user.id);

  const expiresAtMs = Date.now() + WALLET_UNLOCK_TTL * 1000;
  const token = signWalletUnlock(user.id, expiresAtMs, secret);

  const res = Response.json({ ok: true, expiresAt: expiresAtMs });
  res.headers.append(
    "Set-Cookie",
    `${WALLET_UNLOCK_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${WALLET_UNLOCK_TTL}${
      request.url.startsWith("https:") ? "; Secure" : ""
    }`,
  );
  return res;
}
