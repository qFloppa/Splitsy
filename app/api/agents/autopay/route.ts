// The debtor-side agent. Given a freshly created bill, it decides — per
// participant, against that participant's own standing rules — whether to settle
// their share out of the agent's wallet, then does it.
//
// Triggered by the BillCreated branch of app/api/webhooks/circle/route.ts, and
// authorized with the same Bearer secret as the recurring settler: this endpoint
// spends money, so it must never be publicly callable.
//
// Three properties are load-bearing:
//   * The DECISION is pure (lib/autopay.ts). This route only resolves facts —
//     remaining share, creator score, published preimage — and hands them over.
//   * Every skip is logged with its reason. The skip log is the whole point: it
//     is the evidence that an agent holding a spending mandate still declines.
//   * The spend is recorded BEFORE the money moves and released if the send
//     fails. A cap checked after the money moves is not a cap.
import { after } from "next/server";
import {
  autopaySpentSince,
  claimAutopayDecision,
  finalizeAutopayDecision,
  getAutopayGrant,
} from "@/lib/agents-repo";
import { getBillOnchain, getParticipantOnchain, REGISTRY_ADDRESS } from "@/lib/arc-read";
import { decideAutopay } from "@/lib/autopay";
import { executeContractOnArc, getOrCreateArcWallet, InsufficientFundsError } from "@/lib/circle-dcw";
import { getOnchainBillPreimage } from "@/lib/onchain-bill-preimage-repo";
import { encodeApprove, encodeExecuteBatch, encodePayDebtFor } from "@/lib/registry-calldata";
import { getReputationSummaryForWallets } from "@/lib/reputation-repo";
import { getUsersByWallets } from "@/lib/users-repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ARC_USDC_ADDRESS = process.env.ARC_TESTNET_USDC_ADDRESS ?? "0x3600000000000000000000000000000000000000";
const DAY_MS = 24 * 60 * 60 * 1000;

type Outcome = {
  debtor: string;
  decision: "pay" | "skip";
  reason: string;
  amountUsdc: number;
  txHash?: string;
};

export async function POST(request: Request) {
  const denied = authorize(request);
  if (denied) return denied;

  const body: unknown = await request.json().catch(() => null);
  const billIdRaw = (body as { billId?: unknown } | null)?.billId;
  if (billIdRaw === undefined || billIdRaw === null || !/^\d+$/.test(String(billIdRaw))) {
    return Response.json({ error: "Expected { billId }." }, { status: 400 });
  }
  const billId = BigInt(String(billIdRaw));

  const bill = await getBillOnchain(billId).catch(() => null);
  if (!bill) return Response.json({ error: `Bill ${billId} is not readable on chain.` }, { status: 404 });

  // Resolved once for the whole bill, not per participant: the creator's score
  // and the published preimage are the same facts for every debtor.
  const [owners, creatorSummary, preimage] = await Promise.all([
    getUsersByWallets([...bill.participantList]),
    getReputationSummaryForWallets([bill.splitter]),
    getOnchainBillPreimage(REGISTRY_ADDRESS, billId.toString()).catch(() => null),
  ]);

  const agent = await getOrCreateArcWallet("splitsy", "autopay-agent");
  const outcomes: Outcome[] = [];

  for (const address of bill.participantList) {
    const owner = owners.get(address.toLowerCase());
    // A non-custodial participant has no grant to evaluate — nothing to skip,
    // nothing to log. They were never in the agent's scope.
    if (!owner) continue;

    const outcome = await settleOne({
      agent,
      billId,
      debtor: address,
      userId: owner.id,
      splitter: bill.splitter,
      metadataHash: bill.metadataHash,
      preimage,
      creatorScore: creatorSummary.avgScore,
    });
    if (outcome) outcomes.push(outcome);
  }

  return Response.json({ ok: true, billId: billId.toString(), outcomes });
}

async function settleOne(input: {
  agent: { address: string; walletId: string } | null;
  billId: bigint;
  debtor: `0x${string}`;
  userId: string;
  splitter: `0x${string}`;
  metadataHash: `0x${string}`;
  preimage: Awaited<ReturnType<typeof getOnchainBillPreimage>>;
  creatorScore: number | null;
}): Promise<Outcome | null> {
  const { billId, debtor, userId } = input;
  const billKey = billId.toString();

  const [grant, participant] = await Promise.all([
    getAutopayGrant(userId),
    getParticipantOnchain(billId, debtor).catch(() => null),
  ]);

  // Reading the window's spend before deciding is what makes the daily cap
  // real; decideAutopay compares against it rather than trusting a counter.
  const spentTodayUsdc = grant ? await autopaySpentSince(userId, new Date(Date.now() - DAY_MS).toISOString()) : 0;

  const decision = decideAutopay({
    grant,
    remaining: participant?.exists ? participant.owed - participant.paid : 0n,
    creator: input.splitter,
    creatorScore: input.creatorScore,
    spentTodayUsdc,
    onchainMetadataHash: input.metadataHash,
    preimage: input.preimage,
  });

  const amountUsdc = Number(decision.amount) / 1e6;

  // Claim first. The unique key on (registry, bill, debtor) is the idempotency
  // lock, so a redelivered webhook loses the race and spends nothing — and for
  // a 'pay' this same row is the budget reservation.
  const claimed = await claimAutopayDecision({
    userId,
    registryAddress: REGISTRY_ADDRESS,
    billId: billKey,
    debtorAddress: debtor,
    decision: decision.pay ? "pay" : "skip",
    reason: decision.reason,
    amountUsdc: decision.pay ? amountUsdc : 0,
    txHash: null,
  });
  if (!claimed) return null; // already decided by an earlier delivery

  if (!decision.pay) {
    return { debtor, decision: "skip", reason: decision.reason, amountUsdc: 0 };
  }

  if (!input.agent) {
    await releaseSpend(billKey, debtor, "agent_wallet_unavailable");
    return { debtor, decision: "skip", reason: "agent_wallet_unavailable", amountUsdc: 0 };
  }

  // approve + payDebtFor as ONE atomic executeBatch on the agent's SCA wallet:
  // a dangling approval from a half-executed pair would be a standing allowance
  // nobody asked for. payDebtFor credits the debtor while spending the agent's
  // USDC — that asymmetry is the whole reason v2 exists.
  const calls = [
    { to: ARC_USDC_ADDRESS, data: encodeApprove(REGISTRY_ADDRESS, decision.amount) },
    { to: REGISTRY_ADDRESS, data: encodePayDebtFor(billId, debtor, decision.amount) },
  ];

  try {
    const tx = await executeContractOnArc(input.agent.walletId, input.agent.address, encodeExecuteBatch(calls));
    await finalizeAutopayDecision(REGISTRY_ADDRESS, billKey, debtor, { txHash: tx.txHash });

    // Reputation is deliberately NOT recorded here. payDebtFor emits DebtPaid
    // with the DEBTOR as payer, so the existing SCP event monitor already
    // scores this payment through the webhook — on the same (wallet, registry,
    // bill) key. A second scoring path would only race the first for which tag
    // lands, which is worse than one deterministic path.
    after(() => console.log(`autopay: paid bill ${billKey} for ${debtor} — tx ${tx.txHash}`));

    return { debtor, decision: "pay", reason: decision.reason, amountUsdc, txHash: tx.txHash ?? undefined };
  } catch (err) {
    // Roll the reservation back, or one failed send would silently eat the
    // user's daily budget for the next 24 hours.
    const reason = err instanceof InsufficientFundsError ? "agent_out_of_funds" : "tx_failed";
    await releaseSpend(billKey, debtor, reason);
    console.error(`autopay: bill ${billKey} for ${debtor} failed:`, err instanceof Error ? err.message : err);
    return { debtor, decision: "skip", reason, amountUsdc: 0 };
  }
}

// Flip the reserved row back to a skip. autopaySpentSince only sums 'pay' rows,
// so this returns the amount to the user's rolling budget while keeping the
// attempt visible in the log.
async function releaseSpend(billId: string, debtor: string, reason: string) {
  await finalizeAutopayDecision(REGISTRY_ADDRESS, billId, debtor, {
    decision: "skip",
    reason,
    amountUsdc: 0,
  }).catch(() => undefined);
}

function authorize(request: Request) {
  const secret = process.env.AGENT_SECRET ?? process.env.CRON_SECRET;
  if (!secret) {
    return Response.json({ error: "Missing AGENT_SECRET or CRON_SECRET on the server." }, { status: 500 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized autopay request." }, { status: 401 });
  }
  return null;
}
