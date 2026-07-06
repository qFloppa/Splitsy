import { getSessionUser } from "@/lib/session";
import { setUserPin } from "@/lib/users-repo";
import { hashPin } from "@/lib/pin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Whether the signed-in user has set a wallet PIN yet.
export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return Response.json({ error: "Not signed in" }, { status: 401 });
  }
  return Response.json({ hasPin: Boolean(user.pin_hash) });
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
