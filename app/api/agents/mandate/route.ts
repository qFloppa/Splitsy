// Per-bill collect mandates, from the debtor's side.
//
// GET  — every bill this user owes a share of that carries a due date, with the
//        mandate's current on-chain state. This is what the consent UI lists.
// POST — grant or withdraw the mandate for one bill, signed by the user's DCW.
//
// A mandate moves no money by itself: it is a precondition the creditor still
// has to satisfy alongside the due date, the debtor's own USDC approval, their
// balance, and their remaining share. Granting it is therefore session-gated but
// not unlock-gated — the same reasoning as /api/agents/grants. WITHDRAWING it
// must never be harder than granting it, which is why both directions are the
// same call.
import {
  getBillIdsForParticipantOnchain,
  getBillsOnchain,
  getCollectMandateOnchain,
  getParticipantsOnchain,
  REGISTRY_ADDRESS,
} from "@/lib/arc-read";
import { executeContractOnArc, InsufficientFundsError } from "@/lib/circle-dcw";
import { encodeAuthorizeCollect, encodeRevokeCollect } from "@/lib/registry-calldata";
import { getSessionUser } from "@/lib/session";
import { getUsersByWallets } from "@/lib/users-repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const usdc = (v: bigint) => (Number(v) / 1e6).toFixed(2);

export async function GET() {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  if (!user.wallet_address) return Response.json({ mandates: [] });

  const wallet = user.wallet_address as `0x${string}`;
  const billIds = await getBillIdsForParticipantOnchain(wallet).catch(() => []);
  if (billIds.length === 0) return Response.json({ mandates: [] });

  const [bills, parts] = await Promise.all([
    getBillsOnchain([...billIds]),
    getParticipantsOnchain(billIds.map((billId) => ({ billId, addr: wallet }))),
  ]);

  // Only bills with a deadline can ever be collected — a bill with no due date
  // has no moment that "after the due date" names, so offering a mandate on one
  // would be offering a permission that can never be exercised.
  const candidates = bills.flatMap((bill, i) => {
    const p = parts[i];
    if (!bill || bill.dueDate === 0n || !p?.exists) return [];
    const remaining = p.owed - p.paid;
    if (remaining <= 0n) return [];
    return [{ bill, remaining }];
  });

  const [creators, flags] = await Promise.all([
    getUsersByWallets(candidates.map(({ bill }) => bill.splitter)),
    Promise.all(candidates.map(({ bill }) => getCollectMandateOnchain(bill.billId, wallet).catch(() => false))),
  ]);

  return Response.json({
    mandates: candidates.map(({ bill, remaining }, i) => {
      const creator = creators.get(bill.splitter.toLowerCase());
      return {
        billId: bill.billId.toString(),
        // A handle if we know one, otherwise the address — never a blank, because
        // the consent copy names this party.
        creatorLabel: creator ? `@${creator.handle}` : `${bill.splitter.slice(0, 6)}…${bill.splitter.slice(-4)}`,
        remainingUsdc: usdc(remaining),
        dueDateSeconds: Number(bill.dueDate),
        authorized: flags[i],
      };
    }),
  });
}

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  if (!user.circle_wallet_id) {
    return Response.json({ error: "Your wallet isn't provisioned yet. Log in again." }, { status: 409 });
  }

  const body: unknown = await request.json().catch(() => null);
  const raw = (body ?? {}) as { billId?: unknown; authorized?: unknown };
  if (!/^\d+$/.test(String(raw.billId))) {
    return Response.json({ error: "Expected { billId, authorized }." }, { status: 400 });
  }
  const billId = BigInt(String(raw.billId));
  const authorized = raw.authorized === true;

  // The contract enforces participant-only itself, so there is no authorization
  // to re-implement here — only the signer to get right, and that comes from the
  // session, never the body.
  const data = authorized ? encodeAuthorizeCollect(billId) : encodeRevokeCollect(billId);

  try {
    const tx = await executeContractOnArc(user.circle_wallet_id, REGISTRY_ADDRESS, data);
    return Response.json({ ok: true, authorized, txHash: tx.txHash });
  } catch (err) {
    if (err instanceof InsufficientFundsError) {
      return Response.json({ error: "insufficient_funds" }, { status: 402 });
    }
    return Response.json(
      { error: err instanceof Error ? err.message : "Could not update the mandate." },
      { status: 502 },
    );
  }
}
