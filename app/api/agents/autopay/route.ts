// The debtor-side agent. Given a freshly created bill, it decides — per
// participant, against that participant's own standing rules — whether to settle
// their share out of THE PARTICIPANT'S OWN wallet, then does it.
//
// Triggered by the BillCreated branch of app/api/webhooks/circle/route.ts, and
// authorized with the same Bearer secret as the recurring settler: this endpoint
// spends money, so it must never be publicly callable.
//
// The agent is not a sponsor and holds no float. It calls AutopayMandate.payFor,
// which pulls the debtor's USDC under a mandate the debtor wrote on chain. So
// there are two layers, and they are not redundant:
//
//   Layer 1, here — judgment the chain cannot make: the creator's reputation
//     floor and the verified-metadata check, plus a pre-flight of the on-chain
//     caps so a doomed pull never costs gas. Every decline is logged with its
//     reason.
//   Layer 2, AutopayMandate.sol — enforcement: agent identity, creator
//     allowlist, per-bill cap and the daily token bucket. It reverts regardless
//     of what this server believes, which is the point of moving it there.
//
// Three properties are load-bearing:
//   * The DECISION is pure (lib/autopay.ts). This route only resolves facts —
//     remaining share, caps, creator score, published preimage — and hands them
//     over. Note that the caps now come from chain rather than from Postgres.
//   * Every skip is logged with its reason. The skip log is the whole point: it
//     is the evidence that an agent holding a spending mandate still declines.
//   * The spend is recorded BEFORE the money moves and released if the send
//     fails, because autopay_log is also the idempotency key.
import { after } from "next/server";
import {
  claimAutopayDecision,
  finalizeAutopayDecision,
  getAutopayGrant,
  getGrantsByDebtorAddresses,
} from "@/lib/agents-repo";
import {
  getAutopayMandateOnchain,
  getBillOnchain,
  getMandateSpendableOnchain,
  getParticipantOnchain,
  MANDATE_ADDRESS,
  REGISTRY_ADDRESS,
} from "@/lib/arc-read";
import { decideAutopay, type AutopayGrant } from "@/lib/autopay";
import { REVIEW_UNAVAILABLE, reviewBill } from "@/lib/autopay-review";
import { executeContractOnArc, getOrCreateArcWallet, InsufficientFundsError } from "@/lib/circle-dcw";
import { getOnchainBillPreimage } from "@/lib/onchain-bill-preimage-repo";
import { encodePayFor } from "@/lib/registry-calldata";
import { getReputationSummaryForWallets } from "@/lib/reputation-repo";
import { getUsersByWallets } from "@/lib/users-repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const usdc = (units: bigint) => Number(units) / 1e6;

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
  const [owners, linked, creatorSummary, preimage] = await Promise.all([
    getUsersByWallets([...bill.participantList]),
    // Browser wallets never appear in `users` — they are linked to an account on
    // autopay_grants instead (see app/api/agents/link/route.ts). Without this
    // second lookup an EOA participant is skipped before any rule runs.
    getGrantsByDebtorAddresses([...bill.participantList]),
    getReputationSummaryForWallets([bill.splitter]),
    getOnchainBillPreimage(REGISTRY_ADDRESS, billId.toString()).catch(() => null),
  ]);

  const agent = await getOrCreateArcWallet("splitsy", "autopay-agent");
  const outcomes: Outcome[] = [];

  for (const address of bill.participantList) {
    const key = address.toLowerCase();
    const userId = owners.get(key)?.id ?? linked.get(key)?.userId;
    // A participant with neither a Splitsy account nor a linked wallet has no
    // grant to evaluate — nothing to skip, nothing to log. They were never in
    // the agent's scope.
    if (!userId) continue;

    const outcome = await settleOne({
      agent,
      billId,
      debtor: address,
      userId,
      splitter: bill.splitter,
      metadataHash: bill.metadataHash,
      preimage,
      // From chain, not from the preimage: metadataHash commits the joined label
      // string but never the participant addresses, so a preimage can verify
      // cleanly while publishing fewer labels than the bill has people.
      participantCount: bill.participantList.length,
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
  participantCount: number;
  creatorScore: number | null;
}): Promise<Outcome | null> {
  const { billId, debtor, userId } = input;
  const billKey = billId.toString();

  const [rules, mandate, participant, spendable] = await Promise.all([
    // Postgres still owns the two rules the chain cannot evaluate: the ERC-8004
    // score floor (the registry stores individual feedback, not the aggregate)
    // and the verified-hash check (the contract cannot see the preimage).
    getAutopayGrant(userId),
    getAutopayMandateOnchain(debtor).catch(() => null),
    getParticipantOnchain(billId, debtor).catch(() => null),
    // The contract pricing its own pull. Everything decideAutopay checks, plus
    // the two bounds only the token knows: the debtor's approval to the mandate
    // and their balance. Asking costs one eth_call; not asking costs a reverted
    // transaction and a log row that says "tx_failed" instead of why.
    getMandateSpendableOnchain(billId, debtor).catch(() => null),
  ]);

  // A mandate naming somebody else's agent is not this agent's business. Return
  // BEFORE claiming, so no row is written at all: logging `disabled` here would
  // tell a user who deliberately runs their own Circle Agent Wallet that their
  // autopay is off, which is the opposite of true.
  //
  // Distinct from `mandate === null`, which really does mean autopay is off and
  // still logs `disabled` below.
  if (mandate && input.agent && mandate.agent.toLowerCase() !== input.agent.address.toLowerCase()) {
    return null;
  }

  // No mandate, or one naming somebody else's agent, is nothing for this agent
  // to act on. Passing null makes decideAutopay skip with 'disabled', which is
  // exactly what it means: this agent is not permitted to spend here.
  const mine = mandate && input.agent && mandate.agent.toLowerCase() === input.agent.address.toLowerCase();
  const grant: AutopayGrant | null = mine
    ? {
        enabled: true,
        // The caps are read from the contract that enforces them. A cap this
        // route believed but the chain did not would be a cap in name only.
        maxPerBillUsdc: usdc(mandate.maxPerBill),
        maxPerDayUsdc: usdc(mandate.maxPerDay),
        trustedCreators: mandate.allowedCreators,
        minCreatorScore: rules?.minCreatorScore ?? 0,
        requireVerifiedHash: rules?.requireVerifiedHash ?? true,
      }
    : null;

  // Derived from the contract's own token bucket rather than summed from the
  // log, so the figure the agent reasons about is the figure that will bind it.
  const spentTodayUsdc = mandate ? usdc(mandate.maxPerDay - mandate.headroom) : 0;

  const decision = decideAutopay({
    grant,
    remaining: participant?.exists ? participant.owed - participant.paid : 0n,
    creator: input.splitter,
    creatorScore: input.creatorScore,
    spentTodayUsdc,
    onchainMetadataHash: input.metadataHash,
    preimage: input.preimage,
  });

  // The rules passed but the money cannot move: the debtor's approval to the
  // mandate has run down, or their balance has. Named as its own reason because
  // it is the one the user can fix, and "tx_failed" would not tell them how.
  if (decision.pay && spendable === 0n) {
    await claimAutopayDecision({
      userId,
      registryAddress: REGISTRY_ADDRESS,
      billId: billKey,
      debtorAddress: debtor,
      decision: "skip",
      reason: "allowance_short",
      amountUsdc: 0,
      txHash: null,
    });
    return { debtor, decision: "skip", reason: "allowance_short", amountUsdc: 0 };
  }

  // The contents check, last: it is the only step that costs money and latency,
  // so nothing already rejected by a free rule ever reaches it. Fails closed —
  // a timeout or a missing key skips rather than pays.
  if (decision.pay && rules?.requireBillReview !== false) {
    // Nothing to review is not permission to skip reviewing. requireVerifiedHash
    // and requireBillReview are independent: with the hash check off,
    // decideAutopay no longer returns 'unverifiable', so falling through here
    // would leave the payment with neither check.
    if (!input.preimage) {
      await claimAutopayDecision({
        userId,
        registryAddress: REGISTRY_ADDRESS,
        billId: billKey,
        debtorAddress: debtor,
        decision: "skip",
        reason: REVIEW_UNAVAILABLE,
        amountUsdc: 0,
        txHash: null,
      });
      return { debtor, decision: "skip", reason: REVIEW_UNAVAILABLE, amountUsdc: 0 };
    }

    const verdict = await reviewBill({
      preimage: input.preimage,
      shareUsdc: usdc(decision.amount),
      // The on-chain roster, not the published labels: undercounting inflates
      // the even split the model compares the share against.
      participantCount: input.participantCount,
      creatorScore: input.creatorScore,
    });
    if (!verdict.approve) {
      // The model's own sentence goes straight into the log. No slug: the panel
      // renders an unmapped reason verbatim, which is what makes this row worth
      // reading next to "over_bill_cap".
      await claimAutopayDecision({
        userId,
        registryAddress: REGISTRY_ADDRESS,
        billId: billKey,
        debtorAddress: debtor,
        decision: "skip",
        reason: verdict.reason,
        amountUsdc: 0,
        txHash: null,
      });
      return { debtor, decision: "skip", reason: verdict.reason, amountUsdc: 0 };
    }
  }

  const amountUsdc = usdc(decision.amount);

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

  // One call, and it carries no amount: the mandate reads the debtor's full
  // remaining share itself and re-checks every cap on chain. Whatever this
  // route decided, the contract decides again — and its answer is the one that
  // moves money.
  try {
    const tx = await executeContractOnArc(input.agent.walletId, MANDATE_ADDRESS, encodePayFor(billId, debtor));
    await finalizeAutopayDecision(REGISTRY_ADDRESS, billKey, debtor, { txHash: tx.txHash });

    // Reputation is deliberately NOT recorded here. payDebtFor emits DebtPaid
    // with the DEBTOR as payer, so the existing SCP event monitor already
    // scores this payment through the webhook — on the same (wallet, registry,
    // bill) key. A second scoring path would only race the first for which tag
    // lands, which is worse than one deterministic path.
    after(() => console.log(`autopay: paid bill ${billKey} for ${debtor} — tx ${tx.txHash}`));

    return { debtor, decision: "pay", reason: decision.reason, amountUsdc, txHash: tx.txHash ?? undefined };
  } catch (err) {
    // The daily budget needs no rolling back any more — the token bucket only
    // advances inside a payFor that succeeded, so a failed send never consumed
    // it. What does need correcting is the log: a 'pay' row for money that did
    // not move would be a lie in the one record the user is asked to trust.
    const reason = err instanceof InsufficientFundsError ? "agent_out_of_funds" : "tx_failed";
    await releaseSpend(billKey, debtor, reason);
    console.error(`autopay: bill ${billKey} for ${debtor} failed:`, err instanceof Error ? err.message : err);
    return { debtor, decision: "skip", reason, amountUsdc: 0 };
  }
}

// Flip the claimed row back to a skip, keeping the attempt and its reason
// visible. The row stays put rather than being deleted, because it is also the
// idempotency key: removing it would invite a redelivered webhook to retry a
// send that just failed.
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
