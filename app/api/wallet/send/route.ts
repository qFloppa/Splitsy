import { getSessionUser } from "@/lib/session";
import { verifyPin } from "@/lib/pin";
import { transferUsdcOnArc } from "@/lib/circle-dcw";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Send USDC from the signed-in user's DCW to any Arc address, gated by their PIN.
export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) {
    return Response.json({ error: "Not signed in" }, { status: 401 });
  }
  if (!user.circle_wallet_id) {
    return Response.json({ error: "Your wallet isn't provisioned yet." }, { status: 409 });
  }
  if (!user.pin_hash) {
    return Response.json({ error: "Set a wallet PIN first." }, { status: 409 });
  }

  const body = (await request.json().catch(() => null)) as {
    to?: unknown;
    amount?: unknown;
    pin?: unknown;
  } | null;

  const to = String(body?.to ?? "").trim();
  const amount = Number(body?.amount);
  const pin = String(body?.pin ?? "");

  if (!/^0x[a-fA-F0-9]{40}$/.test(to)) {
    return Response.json({ error: "Enter a valid Arc (0x…) address." }, { status: 400 });
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return Response.json({ error: "Enter a positive amount." }, { status: 400 });
  }
  if (!verifyPin(pin, user.pin_hash)) {
    return Response.json({ error: "Incorrect PIN." }, { status: 403 });
  }

  try {
    const tx = await transferUsdcOnArc(user.circle_wallet_id, to, amount.toFixed(6));
    if (tx.state === "FAILED" || tx.state === "DENIED" || tx.state === "CANCELLED") {
      return Response.json({ error: `Transfer ${tx.state.toLowerCase()}` }, { status: 502 });
    }
    return Response.json({ ok: true, txId: tx.id, state: tx.state });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Transfer failed" }, { status: 502 });
  }
}
