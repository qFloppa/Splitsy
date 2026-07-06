import { cookies } from "next/headers";
import { getSessionUser } from "@/lib/session";
import { setUserPin } from "@/lib/users-repo";
import { hashPin } from "@/lib/pin";
import { verifyWalletUnlock, WALLET_UNLOCK_COOKIE } from "@/lib/session-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Whether the signed-in user has set a wallet PIN, and whether the wallet is
// currently unlocked (within the 5-minute window).
export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return Response.json({ error: "Not signed in" }, { status: 401 });
  }
  const secret = process.env.SESSION_SECRET ?? "";
  const token = (await cookies()).get(WALLET_UNLOCK_COOKIE)?.value ?? "";
  const unlocked = verifyWalletUnlock(token, secret, Date.now()) === user.id;
  return Response.json({ hasPin: Boolean(user.pin_hash), unlocked });
}

// Set the wallet PIN (first time only — no reset flow in this demo).
export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) {
    return Response.json({ error: "Not signed in" }, { status: 401 });
  }
  if (user.pin_hash) {
    return Response.json({ error: "A PIN is already set." }, { status: 409 });
  }

  const body = (await request.json().catch(() => null)) as { pin?: unknown } | null;
  const pin = String(body?.pin ?? "");
  if (!/^\d{4,8}$/.test(pin)) {
    return Response.json({ error: "PIN must be 4–8 digits." }, { status: 400 });
  }

  await setUserPin(user.id, hashPin(pin));
  return Response.json({ ok: true });
}
