// The debtor-side agent. Given a freshly created bill, it decides — per
// participant, against that participant's own standing rules — whether to settle
// their share out of THE PARTICIPANT'S OWN wallet, then does it.
//
// Triggered by the BillCreated branch of app/api/webhooks/circle/route.ts, and
// authorized with the same Bearer secret as the recurring settler: this endpoint
// spends money, so it must never be publicly callable.
//
// The agent is not a sponsor and holds no float. In Mandate mode it calls
// AutopayMandate.payFor, which pulls the debtor's USDC under a mandate the
// debtor wrote on chain. So there are two layers, and they are not redundant:
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
//
// Around that decision now sits an ERC-8183 JOB, and the settlement is the work
// it pays for. Three distinct wallets hold the three roles, so nobody grades
// their own work:
//
//   0. decide      the rules above, then a bill review BOUGHT from the Auditor
//                  over x402. Any skip stops here: no job, no transactions.
//   1. createJob   the user's own agent, as the client
//   2. setBudget   the Settler — the PROVIDER prices its own work
//   3. fund        the user's agent, escrowing the fee and nothing else
//   4. settle      payFor (Settler) | payDebtFor (the user's agent)
//   5. submit      the Settler, the deliverable being the settlement tx hashed
//   6. complete    the Auditor, and ONLY after reading getParticipant on chain
//                  and seeing paid >= owed
//
// Step 6 is not a rubber stamp, and it is the reason any of this is worth
// doing: if the debt is not really settled the Auditor does not complete, the
// job expires, and the Settler is not paid for work it did not do.
//
// Two money modes, differing only in whose USDC pays the bill — the FEE is
// always the user's agent's:
//   'mandate' — the user's own wallet, pulled by AutopayMandate.payFor
//   'funded'  — the agent's own balance, via BillSplitRegistry.payDebtFor
//
// ponytail: 6 tx per settled share, 24 for a 4-person bill. Accepted while Arc gas is sub-cent USDC. If it hurts: investigate Circle SCA batch execution to fold createJob+fund and setBudget+submit into single user-ops.
import { after } from "next/server";
import {
  claimAutopayDecision,
  finalizeAutopayDecision,
  getAutopayGrant,
  getGrantsByDebtorAddresses,
  sumAutopaySpentTodayUsdc,
} from "@/lib/agents-repo";
import {
  getAutopayMandateOnchain,
  getBillOnchain,
  getMandateSpendableOnchain,
  getParticipantOnchain,
  MANDATE_ADDRESS,
  REGISTRY_ADDRESS,
} from "@/lib/arc-read";
import {
  buildGrant,
  decideAutopay,
  settlementRowFor,
  type FailureKind,
  type MoneyMode,
  type SettlementProgress,
} from "@/lib/autopay";
import { REVIEW_UNAVAILABLE, type ReviewInput, type ReviewVerdict } from "@/lib/autopay-review";
import {
  executeContractOnArc,
  getOrCreateArcWallet,
  InsufficientFundsError,
  isBroadcast,
} from "@/lib/circle-dcw";
import {
  AGENTIC_COMMERCE_ADDRESS,
  COMPLETE_REASON,
  deliverableFor,
  encodeComplete,
  encodeCreateJob,
  encodeFund,
  encodeSetBudget,
  encodeSubmit,
  isJobsConfigured,
  jobIdFromLogs,
} from "@/lib/erc8183";
import { getOnchainBillPreimage } from "@/lib/onchain-bill-preimage-repo";
import { encodePayDebtFor, encodePayFor } from "@/lib/registry-calldata";
import { getReputationSummaryForWallets } from "@/lib/reputation-repo";
import {
  ensureSettlerGatewayBalance,
  getSettler,
  isIndeterminate,
  isSettlerConfigured,
  settlerReceipt,
  settlerWrite,
} from "@/lib/settler";
import { ensureAgentAllowance, getAgentBalanceUsdc, getOrCreateUserAgent, type UserAgent } from "@/lib/user-agent";
import { getUserById, getUsersByWallets } from "@/lib/users-repo";
import { recordPayment } from "@/lib/x402/payments-repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The ceremony is long and it runs once PER PARTICIPANT, serially. A platform
// timeout mid-ceremony is the worst outcome this route has: the claim row is
// already written 'pay' with a null tx_hash, nothing rolls it back, and
// reclaimUndecided cannot overturn it because 'ok' is not in its UNDECIDED list
// — so the log would permanently claim money moved when it may not have.
//
// 300 is Vercel Hobby's hard ceiling, and it is a BUILD-TIME limit: a larger
// number here does not get clamped, it fails the whole app's deployment. So the
// ceremony is timed to fit INSIDE it rather than the reverse — see
// CEREMONY_POLL_MS. One participant's worst case is now ~205s: six Circle polls
// at 25s, two settlerWrites at 20s, one 15s receipt wait, plus the pre-claim
// buyReview round trip.
//
// A bill whose participants do not all fit is cut off mid-ceremony, and that IS
// the stranded-row case above — the budget buys one clean participant, not
// safety for the rest. Only the sweep below fixes that properly.
// ponytail: a killed request strands its in-flight participant's row as a 'pay' with no tx_hash, and a bill with more participants than fit in 300s will strand one every delivery — the durable fix is a reconciliation sweep over rows older than N minutes in that state, which no cron owns yet
export const maxDuration = 300;

// Every Circle poll and chain wait inside the ceremony is bounded by these
// rather than by their library defaults, which total ~510s against a 300s
// deadline. Being cut short is not a lost settlement: an unresolved send is
// logged 'pay'/settlement_unconfirmed and counted against the cap, which is the
// same fail-closed answer a longer wait would have reached more slowly.
const CEREMONY_POLL_MS = 25_000;
const CEREMONY_WAIT_MS = 20_000;

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

  // The Settler is the address a mandate must name, and it is the same for
  // every participant on the bill. The per-user AGENT is resolved inside
  // settleOne, because it is per account.
  //
  // No Settler and no job market means autopay is OFF — the same reading an
  // unset mandate address already has. Never "settle without the job".
  const settler = isSettlerConfigured() && isJobsConfigured() ? getSettler().address : null;
  // The origin the Settler buys its reviews on, mirroring scoutBaseUrl: a real
  // 402 round trip against this app, not an in-process call.
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? new URL(request.url).origin;
  const outcomes: Outcome[] = [];

  for (const address of bill.participantList) {
    const key = address.toLowerCase();
    const userId = owners.get(key)?.id ?? linked.get(key)?.userId;
    // A participant with neither a Splitsy account nor a linked wallet has no
    // grant to evaluate — nothing to skip, nothing to log. They were never in
    // the agent's scope.
    if (!userId) continue;

    const outcome = await settleOne({
      settler,
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
      baseUrl,
    });
    if (outcome) outcomes.push(outcome);
  }

  return Response.json({ ok: true, billId: billId.toString(), outcomes });
}

// Read defensively rather than trusted: BigInt(NaN) is a RangeError, and at
// module scope that takes the whole route down at import — every webhook 500s
// on a typo in one env var. Every other broken config in this file reads as
// "autopay off", so an unparseable fee falls back to the default instead.
const FEE_ENV = Number(process.env.SETTLEMENT_FEE_USDC ?? "0.01");
const FEE_USDC = Number.isFinite(FEE_ENV) && FEE_ENV >= 0 ? FEE_ENV : 0.01;
const FEE_UNITS = BigInt(Math.round(FEE_USDC * 1_000_000));

// The agent must be able to cover the fee AND its own gas. It signs five of the
// eight transactions a settlement can involve — createJob, fund, up to two lazy
// approvals, and payDebtFor in Funded mode — while the Settler and the Auditor
// pay for their own out of their own balances. Arc charges gas in USDC and this
// is the most an agent ever spends in one go, so the headroom is deliberate
// rather than tight: an agent that runs dry mid-ceremony strands an escrowed fee.
const GAS_HEADROOM_UNITS = 200_000n; // 0.20 USDC

const JOB_TTL_SECONDS = 3600n;

async function settleOne(input: {
  settler: `0x${string}` | null;
  billId: bigint;
  debtor: `0x${string}`;
  userId: string;
  splitter: `0x${string}`;
  metadataHash: `0x${string}`;
  preimage: Awaited<ReturnType<typeof getOnchainBillPreimage>>;
  participantCount: number;
  creatorScore: number | null;
  baseUrl: string;
}): Promise<Outcome | null> {
  const { billId, debtor, userId, settler } = input;
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

  const mode = rules?.moneyMode ?? "mandate";

  // A mandate naming somebody else's agent is not this agent's business.
  // Returns BEFORE claiming, so no row is written at all — logging 'disabled'
  // would tell a user who deliberately runs their own Circle Agent Wallet that
  // their autopay is off, which is the opposite of true.
  //
  // Only in Mandate mode: in Funded mode the mandate is not in the path at all,
  // so what it names is none of this route's business either way.
  if (mode === "mandate" && mandate && settler && mandate.agent.toLowerCase() !== settler.toLowerCase()) {
    return null;
  }

  // buildGrant deliberately does not check the mandate's agent against ours, so
  // this is the only thing standing between one user's agent and another user's
  // mandate. Distinct from `mandate === null`, which really does mean autopay is
  // off and still logs 'disabled' below.
  const mine =
    mode === "mandate" ? Boolean(mandate && settler && mandate.agent.toLowerCase() === settler.toLowerCase()) : true;

  // The caps come from the chain in Mandate mode and from the mirror in Funded
  // mode. One pure function, one branch, testable without a network.
  const grant = buildGrant(
    mode,
    mine && mandate
      ? {
          agent: mandate.agent,
          maxPerBill: mandate.maxPerBill,
          maxPerDay: mandate.maxPerDay,
          allowedCreators: mandate.allowedCreators,
        }
      : null,
    rules
      ? {
          enabled: rules.enabled,
          maxPerBillUsdc: rules.maxPerBillUsdc,
          maxPerDayUsdc: rules.maxPerDayUsdc,
          trustedCreators: rules.trustedCreators,
          minCreatorScore: rules.minCreatorScore,
          requireVerifiedHash: rules.requireVerifiedHash,
        }
      : null,
  );

  // Mandate mode reads the day's spend from the contract's own token bucket, so
  // the figure the agent reasons about is the figure that will bind it. Funded
  // mode has no bucket — the log is the only record.
  const spentTodayUsdc =
    mode === "funded"
      ? await sumAutopaySpentTodayUsdc(userId)
      : mandate
        ? usdc(mandate.maxPerDay - mandate.headroom)
        : 0;

  const decision = decideAutopay({
    grant,
    remaining: participant?.exists ? participant.owed - participant.paid : 0n,
    creator: input.splitter,
    creatorScore: input.creatorScore,
    spentTodayUsdc,
    onchainMetadataHash: input.metadataHash,
    preimage: input.preimage,
  });

  const logSkip = async (reason: string): Promise<Outcome> => {
    await claimAutopayDecision({
      userId,
      registryAddress: REGISTRY_ADDRESS,
      billId: billKey,
      debtorAddress: debtor,
      decision: "skip",
      reason,
      amountUsdc: 0,
      txHash: null,
    });
    return { debtor, decision: "skip", reason, amountUsdc: 0 };
  };

  // Mandate mode only: the rules passed but the money cannot move, because the
  // debtor's approval to the mandate has run down or their balance has. In
  // Funded mode the mandate is not in the path and this bound does not exist.
  if (decision.pay && mode === "mandate" && spendable === 0n) {
    return logSkip("allowance_short");
  }

  // Non-null exactly when the contents check is required AND has something to
  // judge, which is what gates the paid call further down. Null when the user
  // turned the check off; the missing-preimage case returns below instead.
  const reviewPreimage = rules?.requireBillReview === false ? null : input.preimage;

  // Nothing to review is not permission to skip reviewing. requireVerifiedHash
  // and requireBillReview are independent: with the hash check off,
  // decideAutopay no longer returns 'unverifiable', so falling through here
  // would leave the payment with neither check.
  //
  // This free half stays ahead of the claim while the PAID call has moved below
  // the funding check. It has to: REVIEW_UNAVAILABLE is in agents-repo's
  // UNDECIDED list precisely so a redelivery can overturn it once the preimage
  // publishes, and a row already claimed 'ok' could never be overturned that way.
  if (decision.pay && rules?.requireBillReview !== false && !reviewPreimage) {
    return logSkip(REVIEW_UNAVAILABLE);
  }

  const amountUsdc = usdc(decision.amount);

  // Claim first. The unique key on (registry, bill, debtor) is the idempotency
  // lock, taken BEFORE createJob so a redelivered webhook cannot even open a
  // second job — the existing lock covers the new ceremony without widening.
  // It is now also taken before the PAID review, so a redelivery cannot buy a
  // second verdict either.
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

  if (!decision.pay) return { debtor, decision: "skip", reason: decision.reason, amountUsdc: 0 };

  if (!settler) {
    await releaseSpend(billKey, debtor, "agent_wallet_unavailable");
    return { debtor, decision: "skip", reason: "agent_wallet_unavailable", amountUsdc: 0 };
  }

  const user = await getUserById(userId);
  const agent = user ? await getOrCreateUserAgent(user) : null;
  if (!agent) {
    await releaseSpend(billKey, debtor, "agent_wallet_unavailable");
    return { debtor, decision: "skip", reason: "agent_wallet_unavailable", amountUsdc: 0 };
  }

  // The most likely real-world failure, and it gets its own slug so the user is
  // told what to fix. In Funded mode the agent also pays the share, so its
  // balance IS the cap: an agent holding 5 USDC can never spend 6.
  const need = FEE_UNITS + GAS_HEADROOM_UNITS + (mode === "funded" ? decision.amount : 0n);
  const balance = await getAgentBalanceUsdc(agent.address).catch(() => 0n);
  if (balance < need) {
    await releaseSpend(billKey, debtor, "agent_unfunded");
    return { debtor, decision: "skip", reason: "agent_unfunded", amountUsdc: 0 };
  }

  // The contents check, and deliberately the LAST gate: it is the only step that
  // spends money to decide, so everything that can reject for free runs first.
  //
  // It used to sit ahead of the claim, which charged the Settler for verdicts it
  // could never use — a redelivered webhook bought a second one the lock then
  // discarded, and an unfunded agent bought one it could not act on. Neither
  // opened a job, so neither was ever recovered from a fee.
  //
  // Fails closed exactly as before: a timeout, a 402, or an unparseable verdict
  // refuses. The row is already claimed by now, so a refusal FLIPS it with
  // releaseSpend rather than writing it fresh — which keeps the model's own
  // sentence as the reason and leaves REVIEW_UNAVAILABLE reclaimable by a later
  // delivery, exactly as logSkip did.
  //
  // The one cost of claiming first: between the claim and a refusal this share
  // counts against the day's spend in Funded mode. That is the safe direction —
  // a sibling participant briefly sees less headroom, never more.
  if (reviewPreimage) {
    const verdict = await buyReview(
      input.baseUrl,
      {
        preimage: reviewPreimage,
        shareUsdc: amountUsdc,
        // The on-chain roster, not the published labels: undercounting inflates
        // the even split the model compares the share against.
        participantCount: input.participantCount,
        creatorScore: input.creatorScore,
      },
      // Tags the spend row with the bill it was bought for, so the audit trail
      // can show the review next to the job it gated. The seller's matching
      // 'earned' row carries no bill: withGateway settles before the handler
      // runs and never sees one.
      billKey,
    );
    if (!verdict.approve) {
      await releaseSpend(billKey, debtor, verdict.reason);
      return { debtor, decision: "skip", reason: verdict.reason, amountUsdc: 0 };
    }
  }

  // How far the settlement got, filled in by runJob as it goes. Read only on
  // failure, and the only thing standing between a settlement that landed and a
  // log row claiming nothing was spent.
  const progress: SettlementProgress = { settlementTx: null, broadcast: false, jobId: null };

  try {
    const { jobId, settlementTx } = await runJob({
      agent,
      settler,
      billId,
      debtor,
      mode,
      amount: decision.amount,
      progress,
    });
    await finalizeAutopayDecision(REGISTRY_ADDRESS, billKey, debtor, {
      txHash: settlementTx,
      jobId: jobId.toString(),
      jobStatus: "completed",
      feeUsdc: FEE_USDC,
    });

    // Reputation is deliberately NOT recorded here, in either mode. payFor and
    // payDebtFor both emit DebtPaid with the DEBTOR as payer, so the existing
    // SCP event monitor already scores this payment on the same (wallet,
    // registry, bill) key. A second path would only race the first.
    after(() => console.log(`autopay: paid bill ${billKey} for ${debtor} — job ${jobId}, tx ${settlementTx}`));

    return { debtor, decision: "pay", reason: decision.reason, amountUsdc, txHash: settlementTx };
  } catch (err) {
    // The daily budget needs no rolling back — the token bucket only advances
    // inside a payFor that succeeded. What does need correcting is the log, and
    // in BOTH directions: a 'pay' row for money that did not move is a lie, and
    // so is a zero-amount 'skip' for money that did. settlementRowFor decides
    // which, off how far runJob actually got.
    const kind: FailureKind =
      err instanceof InsufficientFundsError
        ? "insufficient_funds"
        : err instanceof WalletUnavailableError
          ? "wallet_unavailable"
          : err instanceof JobError
            ? "job"
            : "other";
    const row = settlementRowFor(progress, kind, amountUsdc);
    await finalizeAutopayDecision(REGISTRY_ADDRESS, billKey, debtor, row).catch(() => undefined);
    console.error(`autopay: bill ${billKey} for ${debtor} failed:`, err instanceof Error ? err.message : err);
    return {
      debtor,
      decision: row.decision,
      reason: row.reason,
      amountUsdc: row.amountUsdc,
      txHash: row.txHash ?? undefined,
    };
  }
}

// Thrown when a job transaction fails, so the catch above can log 'job_failed'
// rather than the vaguer 'tx_failed'. The distinction matters to whoever reads
// the log: one means the escrow ceremony broke, the other means the bill money
// did not move.
class JobError extends Error {
  constructor(step: string, cause: unknown) {
    super(`job ${step}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "JobError";
  }
}

// A role in the ceremony has no wallet at all. Same fact as a missing Settler or
// a missing user agent, so it carries their slug out of runJob rather than being
// flattened into 'job_failed', which would send the operator hunting for a
// reverted transaction that never existed.
class WalletUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletUnavailableError";
  }
}

// The six-transaction ceremony. Every signature belongs to a wallet the server
// controls, so the user gets no prompt at settlement time — they signed once at
// setup, and that is the whole point.
//
// Job-first is the honest lifecycle order, and it is affordable because the
// ESCROW ONLY EVER HOLDS THE FEE. If the settlement fails the job sits Funded,
// expires an hour later, and at worst 0.01 USDC of the agent's balance is
// stranded. The bill money is never at risk in either ordering.
// UNVERIFIED (spec §12 Q3): whether an Expired job returns the escrow.
async function runJob(input: {
  agent: UserAgent;
  settler: `0x${string}`;
  billId: bigint;
  debtor: `0x${string}`;
  mode: MoneyMode;
  amount: bigint;
  progress: SettlementProgress;
}): Promise<{ jobId: bigint; settlementTx: `0x${string}` }> {
  const { agent, settler, billId, debtor, progress } = input;
  // Its absence is the same fact as a missing Settler — a role in the ceremony
  // has no wallet — so it gets the same slug rather than the vaguer 'job_failed'.
  const auditor = await getOrCreateArcWallet("splitsy", "auditor");
  if (!auditor) throw new WalletUnavailableError("the Auditor wallet is unavailable");

  const expiredAt = BigInt(Math.floor(Date.now() / 1000)) + JOB_TTL_SECONDS;
  const description = `Splitsy: settle bill ${billId} share for ${debtor}`;

  // 1. createJob — the user's agent is the client.
  let jobId: bigint;
  try {
    const created = await executeContractOnArc(
      agent.walletId,
      AGENTIC_COMMERCE_ADDRESS,
      encodeCreateJob(settler, auditor.address as `0x${string}`, expiredAt, description),
      CEREMONY_POLL_MS,
    );
    if (!created.txHash) throw new Error("createJob is still pending — no tx hash");
    // Circle reports COMPLETE from its own indexer, which can run ahead of the
    // public RPC, so this WAITS for the receipt rather than demanding it now.
    const receipt = await settlerReceipt(created.txHash as `0x${string}`, CEREMONY_WAIT_MS);
    const id = jobIdFromLogs(receipt.logs);
    if (id === null) throw new Error("createJob receipt has no JobCreated log");
    jobId = id;
    // Recorded before anything else can throw, so every later failure row can
    // name the job an operator has to finish or expire by hand.
    progress.jobId = id.toString();
  } catch (err) {
    // An agent too poor to open a job is 'agent_unfunded', not 'job_failed' —
    // that is the case the slug was introduced for, and wrapping it here would
    // hide it from the instanceof test in settleOne's catch.
    if (err instanceof InsufficientFundsError) throw err;
    throw new JobError("createJob", err);
  }

  // 2. setBudget — the PROVIDER prices the work, which is why the Settler signs
  //    it and not the client. Tutorial order: createJob → setBudget → fund.
  try {
    await settlerWrite(AGENTIC_COMMERCE_ADDRESS, encodeSetBudget(jobId, FEE_UNITS), CEREMONY_WAIT_MS);
  } catch (err) {
    throw new JobError("setBudget", err);
  }

  // 3. fund — the fee into escrow, preceded by the lazy approval.
  try {
    await ensureAgentAllowance(agent, AGENTIC_COMMERCE_ADDRESS, FEE_UNITS, CEREMONY_POLL_MS);
    await executeContractOnArc(agent.walletId, AGENTIC_COMMERCE_ADDRESS, encodeFund(jobId), CEREMONY_POLL_MS);
  } catch (err) {
    if (err instanceof InsufficientFundsError) throw err;
    throw new JobError("fund", err);
  }

  // 4. settle — the only step that moves BILL money, and the only one that
  //    differs between the two modes.
  //
  //    Deliberately NOT wrapped in a JobError: the bill money failing is a
  //    different problem from the ceremony failing, and InsufficientFundsError
  //    must reach settleOne intact so it can be logged as 'agent_unfunded'.
  //
  //    Everything from here on records its progress on `input.progress`, which
  //    the caller reads on failure. Once the send is away the money may move
  //    whatever this function throws, and a row that fails to say so hands the
  //    user back a daily cap they have already spent.
  let settlementTx: `0x${string}`;
  if (input.mode === "funded") {
    // The agent pays out of its own balance. payDebtFor credits the DEBTOR
    // and emits DebtPaid naming them as payer, so reputation still flows to
    // the user rather than to their agent.
    await ensureAgentAllowance(agent, REGISTRY_ADDRESS, input.amount, CEREMONY_POLL_MS);
    try {
      const tx = await executeContractOnArc(
        agent.walletId,
        REGISTRY_ADDRESS,
        encodePayDebtFor(billId, debtor, input.amount),
        CEREMONY_POLL_MS,
      );
      // PENDING past the poll cap, with no hash to show for it. Circle accepted
      // the transaction, so it may mine seconds from now: an unconfirmed
      // settlement rather than a clean failure, and it must count against the cap.
      if (!tx.txHash) {
        progress.broadcast = true;
        throw new Error("payDebtFor is still pending — no tx hash");
      }
      settlementTx = tx.txHash as `0x${string}`;
    } catch (err) {
      // Only Circle's own tag can tell these apart, which is why it exists.
      // Rejected at creation, DENIED, CANCELLED and a reverted FAILED all moved
      // nothing and never will — this is the debtor-paid-manually race, and
      // charging it against the day would refuse their next real bill. A throw
      // from inside the poll is the opposite: the transaction is away.
      if (isBroadcast(err)) progress.broadcast = true;
      throw err;
    }
  } else {
    // One call, carrying no amount: the mandate reads the debtor's full
    // remaining share itself and re-checks every cap on chain. Whatever this
    // route decided, the contract decides again.
    try {
      settlementTx = await settlerWrite(MANDATE_ADDRESS, encodePayFor(billId, debtor), CEREMONY_WAIT_MS);
    } catch (err) {
      // Same fork, the other library's tag: broadcast-but-unconfirmed counts,
      // a revert does not.
      if (isIndeterminate(err)) progress.broadcast = true;
      throw err;
    }
  }
  progress.settlementTx = settlementTx;

  // 5. submit — the deliverable IS the settlement transaction, hashed, so
  //    anyone holding the tx hash can recompute it and check the job.
  try {
    await settlerWrite(AGENTIC_COMMERCE_ADDRESS, encodeSubmit(jobId, deliverableFor(settlementTx)), CEREMONY_WAIT_MS);
  } catch (err) {
    throw new JobError("submit", err);
  }

  // 6. complete — NOT a rubber stamp. The Auditor reads the registry on chain
  //    and completes only when the debt is really settled. If it is not, the
  //    job expires and the Settler is not paid. This is what separates a job
  //    market from theatre.
  try {
    const settled = await getParticipantOnchain(billId, debtor);
    if (!settled.exists || settled.paid < settled.owed) {
      throw new Error(`registry still shows ${settled.paid} paid of ${settled.owed} owed`);
    }
    await executeContractOnArc(
      auditor.walletId,
      AGENTIC_COMMERCE_ADDRESS,
      encodeComplete(jobId, COMPLETE_REASON),
      CEREMONY_POLL_MS,
    );
  } catch (err) {
    throw new JobError("complete", err);
  }

  return { jobId, settlementTx };
}

// The Settler buys the verdict from the Auditor over a real 402 round trip,
// exactly as Scout already buys /api/ocr. Both sides run in this same Next.js
// process and that is fine: Circle Gateway verifies and settles a real payment
// between two distinct addresses, and the loopback is the proven shape in this
// repo rather than a shortcut invented here.
//
// Fails closed on everything — a 402, a timeout, an unparseable verdict, a
// missing key, AND an x402 settlement failure. A Settler that cannot pay for a
// review does not settle anything.
async function buyReview(baseUrl: string, body: ReviewInput, billRef: string): Promise<ReviewVerdict> {
  try {
    // Swallows its own failures by design (lib/settler.ts), so there is nothing
    // here to catch: a failed top-up surfaces as the pay below declining.
    await ensureSettlerGatewayBalance();
    const { gateway } = getSettler();
    const result = await gateway.pay(`${baseUrl}/api/agents/review`, { method: "POST", body });

    // Recorded BEFORE the body is inspected, because by this line the money is
    // already gone: Gateway settled the payment to get the response at all. An
    // unreadable verdict still costs the Settler its fee, and a spend the
    // ledger never saw is the one kind of error the x402 books cannot survive.
    after(() =>
      recordPayment({
        direction: "spent",
        endpoint: "/api/agents/review",
        counterparty: getSettler().address,
        amountUsdc: (Number(result.amount) / 1e6).toString(),
        gatewayTx: result.transaction || null,
        billRef,
      }),
    );

    const data = result.data as { approve?: unknown; reason?: unknown };
    if (typeof data?.approve !== "boolean") return { approve: false, reason: REVIEW_UNAVAILABLE };

    const reason = typeof data.reason === "string" && data.reason.trim() ? data.reason.trim() : "";
    return data.approve
      ? { approve: true, reason: reason || "Bill contents look consistent with this share." }
      : { approve: false, reason: reason || "The agent could not justify this bill's contents." };
  } catch (err) {
    console.warn("[autopay] the Settler could not buy a review; refusing:", err instanceof Error ? err.message : err);
    return { approve: false, reason: REVIEW_UNAVAILABLE };
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
