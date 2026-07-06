import { getSessionUser } from "@/lib/session";
import { verifyPin } from "@/lib/pin";
import { signWalletUnlock, WALLET_UNLOCK_COOKIE, WALLET_UNLOCK_TTL } from "@/lib/session-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Verify the wallet PIN once and issue a short-lived unlock cookie so sends
// within the next few minutes don't re-prompt.
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

  const body = (await request.json().catch(() => null)) as { pin?: unknown } | null;
  const pin = String(body?.pin ?? "");
  if (!verifyPin(pin, user.pin_hash)) {
    return Response.json({ error: "Incorrect PIN." }, { status: 403 });
  }

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
