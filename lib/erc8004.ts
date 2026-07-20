// Server-side ERC-8004 integration (agent identity + payment reputation) on
// Arc Testnet, using the registries Arc pre-deploys (docs.arc.io "Register
// your first AI agent"). Splitsy uses them to give each payer wallet an
// on-chain identity NFT and to record verifiable payment reputation.
//
// Consent policy — the part that makes this griefing-proof: feedback is
// positive-only and recorded ONLY for a payDebt the wallet itself executed.
// Paying is the consent; a debt someone merely tagged you into records
// nothing. "No history" must therefore always display as neutral, never bad.
//
// Two payment paths earn reputation, both anchored to an on-chain DebtPaid:
//   1. Circle DCW payers — the pay route calls recordPaidFeedback in after();
//      the payer's own DCW signs the register() tx (it just paid, so it has gas).
//   2. Browser/non-custodial payers — never touch the server, so a Circle SCP
//      event monitor on BillSplitRegistry.DebtPaid POSTs to the webhook, which
//      calls recordExternalPaidFeedback. Splitsy can't sign as their wallet, so
//      a dedicated REGISTRAR DCW mints the identity NFT on their behalf and
//      then transfers it to the payer (register() only mints to msg.sender);
//      the payer→agent binding stays verifiable via the feedbackHash below.
//
// DCW payments fire BOTH paths (the webhook sees their DebtPaid too), so
// registration and scoring are each serialized by a DB claim — without it the
// two paths each minted an NFT and double-scored the payment on-chain.
//
// Per ERC-8004 an agent's owner cannot score its own agent, so feedback comes
// from a dedicated validator DCW, and the registrar is a THIRD distinct wallet
// (it holds externally-paid agents at mint time, so it can't also be the scorer).
// Each feedback commits feedbackHash = keccak256("splitsy:bill:<id>:<payTx>"),
// so anyone can re-verify a score against the DebtPaid event it claims to score.
import { createPublicClient, decodeEventLog, encodeFunctionData, http, keccak256, toHex } from "viem";
import { arcTestnet } from "viem/chains";
import { getParticipantOnchain, REGISTRY_ADDRESS } from "./arc-read.ts";
import { executeContractOnArc, getOrCreateArcWallet } from "./circle-dcw.ts";
import { getOnchainBillPreimage } from "./onchain-bill-preimage-repo.ts";
import {
  claimAgentRegistration,
  claimFeedback,
  finalizeAgentRegistration,
  getAgentByWallet,
  hasFeedbackForBill,
  releaseAgentClaim,
  releaseFeedbackClaim,
  setFeedbackTx,
} from "./reputation-repo.ts";
import { scorePaymentTiming } from "./reputation-score.ts";

// Arc Testnet ERC-8004 registries (docs.arc.io); env-overridable for redeploys.
export const IDENTITY_REGISTRY = (process.env.ERC8004_IDENTITY_REGISTRY ??
  "0x8004A818BFB912233c491871b3d84c89A494BD9e") as `0x${string}`;
export const REPUTATION_REGISTRY = (process.env.ERC8004_REPUTATION_REGISTRY ??
  "0x8004B663056A597Dffe9eCcC1965A193B7388713") as `0x${string}`;

const PINATA_JWT = process.env.PINATA_JWT ?? "";

const ERC8004_ABI = [
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [{ name: "metadataURI", type: "string" }],
    outputs: [{ name: "tokenId", type: "uint256" }],
  },
  {
    type: "function",
    name: "transferFrom", // the registry is a plain transferable ERC-721
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "giveFeedback",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "score", type: "int128" },
      { name: "decimals", type: "uint8" },
      { name: "tag1", type: "string" },
      { name: "tag2", type: "string" },
      { name: "fileuri", type: "string" },
      { name: "filehash", type: "string" },
      { name: "feedbackHash", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

// ERC-721 Transfer, emitted by IdentityRegistry.register when the identity
// NFT mints to the caller. tokenId (= agentId) is the third indexed topic.
const TRANSFER_TOPIC = keccak256(toHex("Transfer(address,address,uint256)"));

// BillSplitRegistry.DebtPaid — the event a Circle SCP monitor delivers for
// browser payments. payer is indexed; amount/paidTotal/owedTotal are in data.
// A payment is "paid in full" iff paidTotal >= owedTotal.
const DEBT_PAID_ABI = [
  {
    type: "event",
    name: "DebtPaid",
    anonymous: false,
    inputs: [
      { indexed: true, name: "billId", type: "uint256" },
      { indexed: true, name: "payer", type: "address" },
      { indexed: false, name: "amount", type: "uint256" },
      { indexed: false, name: "paidTotal", type: "uint256" },
      { indexed: false, name: "owedTotal", type: "uint256" },
    ],
  },
] as const;

export const DEBT_PAID_EVENT_SIGNATURE =
  "DebtPaid(uint256,address,uint256,uint256,uint256)";

export type DebtPaidLog = {
  billId: string;
  payer: `0x${string}`;
  paidInFull: boolean;
};

// Decode a DebtPaid event-log notification (topics + data as delivered by
// Circle's SCP webhook) into the fields reputation cares about. Returns null if
// the topics/data don't decode as DebtPaid, so the webhook can ignore noise.
export function parseDebtPaidLog(topics: string[], data: string): DebtPaidLog | null {
  try {
    const decoded = decodeEventLog({
      abi: DEBT_PAID_ABI,
      topics: topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
      data: (data ?? "0x") as `0x${string}`,
    });
    if (decoded.eventName !== "DebtPaid") return null;
    const { billId, payer, paidTotal, owedTotal } = decoded.args;
    return {
      billId: billId.toString(),
      payer: payer.toLowerCase() as `0x${string}`,
      paidInFull: paidTotal >= owedTotal,
    };
  } catch {
    return null;
  }
}

const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL ?? "https://rpc.testnet.arc.network"),
});

// The identity NFT artwork: a ring split into shares (a bill) closing around
// a paid check mark. Inline SVG data URI so no image hosting or pinning is
// needed; set SPLITSY_AGENT_IMAGE_URI to an ipfs:// or https:// file to
// override. Explorers read the standard ERC-721 `image` key from tokenURI JSON.
const AGENT_IMAGE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">' +
  '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
  '<stop offset="0" stop-color="#34d399"/><stop offset="1" stop-color="#0ea5e9"/>' +
  "</linearGradient></defs>" +
  '<rect width="512" height="512" rx="64" fill="#0f172a"/>' +
  '<g transform="translate(256 234)">' +
  '<circle r="120" fill="none" stroke="url(#g)" stroke-width="26" stroke-linecap="round" stroke-dasharray="126 24.8" transform="rotate(-14)"/>' +
  '<path d="M-48 8 L-14 42 L56 -36" fill="none" stroke="#e2e8f0" stroke-width="30" stroke-linecap="round" stroke-linejoin="round"/>' +
  "</g>" +
  '<text x="256" y="428" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="46" font-weight="700" fill="#e2e8f0" letter-spacing="10">SPLITSY</text>' +
  '<text x="256" y="468" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-size="20" font-weight="600" fill="#64748b" letter-spacing="6">PAYER AGENT</text>' +
  "</svg>";

const AGENT_IMAGE_URI =
  process.env.SPLITSY_AGENT_IMAGE_URI ?? `data:image/svg+xml,${encodeURIComponent(AGENT_IMAGE_SVG)}`;

// Upload ERC-8004 agent metadata to IPFS via Pinata. Returns ipfs:// URI or
// falls back to data: URI if Pinata is unconfigured (reputation still works,
// just without discoverable off-chain metadata). Exported for the one-off
// scripts/reputation-backfill.ts, which re-points existing agents at it.
export async function uploadMetadataToIPFS(walletAddress: string): Promise<string> {
  if (!PINATA_JWT) {
    const fallback = {
      name: "Splitsy payer",
      description: "Payment reputation agent for Splitsy bill-splitting app",
      image: AGENT_IMAGE_URI,
      agent_type: "splitsy-payer",
      version: "1",
      wallet: walletAddress,
    };
    return `data:application/json,${encodeURIComponent(JSON.stringify(fallback))}`;
  }

  const metadata = {
    name: `Splitsy Payer ${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`,
    description: "Payment reputation agent for Splitsy bill-splitting app on Arc Testnet",
    image: AGENT_IMAGE_URI,
    agent_type: "splitsy-payer",
    version: "1",
    wallet: walletAddress,
    created_at: new Date().toISOString(),
    capabilities: ["payment_verification", "debt_settlement"],
    platform: "splitsy",
  };

  try {
    const res = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PINATA_JWT}`,
      },
      body: JSON.stringify({
        pinataContent: metadata,
        pinataMetadata: { name: `splitsy-agent-${walletAddress}` },
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Pinata upload failed (${res.status}): ${text}`);
    }

    const { IpfsHash } = (await res.json()) as { IpfsHash: string };
    return `ipfs://${IpfsHash}`;
  } catch (err) {
    console.error("IPFS metadata upload failed, falling back to data: URI:", err);
    const fallback = {
      name: "Splitsy payer",
      description: "Payment reputation agent for Splitsy",
      image: AGENT_IMAGE_URI,
      agent_type: "splitsy-payer",
      version: "1",
      wallet: walletAddress,
    };
    return `data:application/json,${encodeURIComponent(JSON.stringify(fallback))}`;
  }
}

// The Splitsy validator DCW that records all feedback. Distinct refId
// namespace from signin ("<provider>:<id>") and pre-mint ("prem:...") wallets,
// so it can never collide with a payer wallet — which is what keeps the
// ERC-8004 "owner cannot score own agent" rule satisfied.
// It pays its own gas in USDC and must be faucet-funded once (see README).
async function getValidatorWallet() {
  const wallet = await getOrCreateArcWallet("splitsy", "reputation-validator");
  if (!wallet) throw new Error("Circle is not configured — no validator wallet");
  return wallet;
}

// The registrar DCW mints identity NFTs for browser/non-custodial payers, who
// pay directly on-chain and never hand Splitsy a wallet to sign with, then
// transfers each NFT on to its payer (ensureAgent). It must be a THIRD wallet,
// distinct from both payer wallets and the validator: it owns each
// externally-paid agent at mint time (longer if the transfer fails), and
// ERC-8004 forbids an agent's owner from scoring it — so the validator, not
// the registrar, scores. Faucet-funded once for gas, same as the validator
// (see README).
async function getRegistrarWallet() {
  const wallet = await getOrCreateArcWallet("splitsy", "reputation-registrar");
  if (!wallet) throw new Error("Circle is not configured — no registrar wallet");
  return wallet;
}

// Wallet → agentId, registering the identity NFT on first use. Lazy on
// purpose: registration is a tx paid by the member's wallet, and the only
// caller is the post-payment hook — at which point the wallet demonstrably
// holds USDC for gas.
//
// Rival paths race here — a DCW payment fires both the pay route's after()
// hook and the DebtPaid webhook — so registration is serialized by a DB claim
// (see claimAgentRegistration): exactly one caller mints, losers wait for its
// agent id. Before the claim existed, both paths minted and the payer's agent
// got a duplicate NFT held by the registrar.
//
// minterAddress is the wallet circleWalletId signs as. When it isn't the
// payer (the registrar registering on a browser payer's behalf — register()
// always mints to msg.sender, the deployed registry has no register-for), the
// fresh NFT is transferred on to the payer, so every payer ends up owning
// their own identity NFT. The transfer is best-effort: a failure leaves the
// NFT with the registrar but never blocks scoring.
export async function ensureAgent(
  walletAddress: string,
  circleWalletId: string,
  minterAddress?: string,
): Promise<string> {
  const existing = await getAgentByWallet(walletAddress);
  if (existing?.agent_id) return existing.agent_id;

  if ((await claimAgentRegistration(walletAddress)) !== "won") {
    return waitForAgentRegistration(walletAddress);
  }

  let agentId: string;
  let registerTx: string;
  try {
    const metadataURI = await uploadMetadataToIPFS(walletAddress);
    const callData = encodeFunctionData({
      abi: ERC8004_ABI,
      functionName: "register",
      args: [metadataURI],
    });
    const tx = await executeContractOnArc(circleWalletId, IDENTITY_REGISTRY, callData);
    if (!tx.txHash) throw new Error("agent registration still pending — no tx hash");

    // Read the minted tokenId from the receipt's Transfer log rather than
    // eth_getLogs (range-capped on Arc, and the receipt is authoritative).
    // Match the mint TO our minter: Circle SCA user-ops share ERC-4337 bundle
    // txs, so the receipt can also contain another wallet's mint.
    const mintedTo = (minterAddress ?? walletAddress).toLowerCase();
    const receipt = await publicClient.getTransactionReceipt({ hash: tx.txHash as `0x${string}` });
    const mint = receipt.logs.find(
      (log) =>
        log.address.toLowerCase() === IDENTITY_REGISTRY.toLowerCase() &&
        log.topics[0] === TRANSFER_TOPIC &&
        log.topics.length === 4 &&
        `0x${log.topics[2]!.slice(-40).toLowerCase()}` === mintedTo,
    );
    if (!mint) throw new Error("agent registration receipt has no Transfer log");
    agentId = BigInt(mint.topics[3]!).toString();
    registerTx = tx.txHash;
  } catch (err) {
    // Failed before finalizing — free the claim so a later event can retry.
    await releaseAgentClaim(walletAddress).catch(() => undefined);
    throw err;
  }
  await finalizeAgentRegistration(walletAddress, agentId, registerTx);

  if (minterAddress && minterAddress.toLowerCase() !== walletAddress.toLowerCase()) {
    try {
      const transferData = encodeFunctionData({
        abi: ERC8004_ABI,
        functionName: "transferFrom",
        args: [minterAddress as `0x${string}`, walletAddress as `0x${string}`, BigInt(agentId)],
      });
      await executeContractOnArc(circleWalletId, IDENTITY_REGISTRY, transferData);
    } catch (err) {
      console.error(
        `reputation: agent ${agentId} minted but transfer to ${walletAddress} failed (NFT stays with registrar):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return agentId;
}

// Another path holds the registration claim; wait for it to finalize. The
// winner spends up to ~60s polling Circle plus a receipt read, so allow 90s.
async function waitForAgentRegistration(walletAddress: string): Promise<string> {
  for (let i = 0; i < 18; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const agent = await getAgentByWallet(walletAddress);
    if (agent?.agent_id) return agent.agent_id;
  }
  throw new Error(`agent registration for ${walletAddress} did not finalize in time`);
}

export type PaidFeedbackInput = {
  payerAddress: string;
  payerWalletId: string;
  billId: string; // on-chain BillSplitRegistry bill id
  paymentTxHash: string; // the payDebt tx — the consent anchor
};

// The timing + amount context a payment is graded on. Every field is read from
// an authoritative source (chain or the committed preimage), never the caller.
type ScoringContext = {
  dueDate: number; // committed Unix seconds (0 = the bill had no deadline)
  paidAt: number; //  payDebt block timestamp — what we grade against, not now()
  shareUnits: number; // payer's owed share in USDC base units (weights the avg)
};

// Resolve when a payment settled, the deadline it was due, and the payer's share.
//
// paidAt comes from the block the payDebt tx was mined in — authoritative and
// identical across the DCW, webhook, and replay paths, unlike a server clock.
// dueDate comes from the preimage the creator committed into the metadataHash,
// so it can't be moved after the fact. Each lookup degrades independently: a
// missing due date scores as "no deadline" (a clean 100), and a share we can't
// read falls back to 0 (neutral weight) — scoring must never fail a payment.
async function resolveScoringContext(billId: string, paymentTxHash: string, payerAddress: string): Promise<ScoringContext> {
  let paidAt = 0;
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: paymentTxHash as `0x${string}` });
    const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
    paidAt = Number(block.timestamp);
  } catch (err) {
    console.error(`reputation: could not read block time for ${paymentTxHash}:`, err instanceof Error ? err.message : err);
  }

  let dueDate = 0;
  try {
    const preimage = await getOnchainBillPreimage(REGISTRY_ADDRESS, billId);
    dueDate = preimage?.dueDate && preimage.dueDate > 0 ? preimage.dueDate : 0;
  } catch (err) {
    console.error(`reputation: could not read due date for bill ${billId}:`, err instanceof Error ? err.message : err);
  }

  let shareUnits = 0;
  try {
    const participant = await getParticipantOnchain(BigInt(billId), payerAddress as `0x${string}`);
    shareUnits = Number(participant.owed);
  } catch (err) {
    console.error(`reputation: could not read share for bill ${billId}:`, err instanceof Error ? err.message : err);
  }

  return { dueDate, paidAt, shareUnits };
}

// giveFeedback from the validator wallet, then mirror the row for display.
// Shared by both payment paths; the caller has already resolved the payer's
// agentId (registered by whichever wallet is appropriate). Idempotent guard
// lives in the callers.
//
// The score grades timeliness against the committed due date (see
// scorePaymentTiming): no deadline or paid on time = 100; late loses points on a
// gentle curve down to a floor of 50. The payer's share is stored so the badge
// can weight its average by amount. If the block time can't be read we can't
// grade timing fairly, so we fall back to a clean 100 rather than penalize a
// payer for our own read failure.
// Grade a resolved payment, record it on the ReputationRegistry from the
// validator wallet, and mirror the row. The one place giveFeedback + insert
// live, shared by every payment shape (one-off bills and recurring cycles) —
// callers differ only in how they resolve the context and the two keys below.
//
//   storageKey — written to the mirror's bill_id column; the unique
//     (wallet, bill_id) constraint is what makes each payment scored once. A
//     one-off bill uses its numeric id; a recurring cycle uses a per-cycle key
//     so each cycle scores independently.
//   feedbackTag — the human-readable tag2 committed on-chain, also folded into
//     feedbackHash = keccak256("splitsy:<feedbackTag>:<paymentTxHash>") so any
//     score stays re-verifiable against the on-chain payment it claims to score.
async function commitFeedback(input: {
  payerAddress: string;
  agentId: string;
  storageKey: string;
  feedbackTag: string;
  paymentTxHash: string;
  ctx: ScoringContext;
}): Promise<void> {
  const { ctx } = input;
  // paidAt === 0 means the block read failed; grade as "no deadline" so a read
  // failure never costs the payer points.
  const timing = scorePaymentTiming(ctx.paidAt > 0 ? ctx.dueDate : 0, ctx.paidAt);

  // Claim (wallet, storageKey) BEFORE the on-chain call. Rival paths race
  // here too (pay-route after() vs webhook), and the old check-then-insert
  // let the validator double-score a payment on-chain.
  const claimed = await claimFeedback({
    wallet_address: input.payerAddress,
    agent_id: input.agentId,
    bill_id: input.storageKey,
    score: timing.score,
    tag: timing.tag,
    payment_tx: input.paymentTxHash,
    feedback_tx: null,
    share_units: ctx.shareUnits,
    due_date: ctx.dueDate,
    paid_at: ctx.paidAt,
  });
  if (!claimed) {
    console.log(
      `reputation: ${input.storageKey} for ${input.payerAddress} already scored or being scored — skip`,
    );
    return;
  }

  try {
    const validator = await getValidatorWallet();
    const feedbackHash = keccak256(toHex(`splitsy:${input.feedbackTag}:${input.paymentTxHash}`));
    const callData = encodeFunctionData({
      abi: ERC8004_ABI,
      functionName: "giveFeedback",
      args: [
        BigInt(input.agentId),
        BigInt(timing.score),
        0,
        timing.tag,
        input.feedbackTag,
        `tx:${input.paymentTxHash}`,
        "",
        feedbackHash,
      ],
    });
    const tx = await executeContractOnArc(validator.walletId, REPUTATION_REGISTRY, callData);
    await setFeedbackTx(input.payerAddress, input.storageKey, tx.txHash);
  } catch (err) {
    // Free the claim so a later replay can score this payment.
    await releaseFeedbackClaim(input.payerAddress, input.storageKey).catch(() => undefined);
    throw err;
  }
}

async function scorePaidInFull(input: {
  payerAddress: string;
  agentId: string;
  billId: string;
  paymentTxHash: string;
}): Promise<void> {
  const ctx = await resolveScoringContext(input.billId, input.paymentTxHash, input.payerAddress);
  await commitFeedback({
    payerAddress: input.payerAddress,
    agentId: input.agentId,
    storageKey: input.billId,
    feedbackTag: `bill:${input.billId}`,
    paymentTxHash: input.paymentTxHash,
    ctx,
  });
}

// Record "paid_in_full" for a completed payDebt: register the payer's agent if
// needed (their own DCW signs, since it just paid and holds gas), then score.
// Idempotent per (payer, bill).
export async function recordPaidFeedback(input: PaidFeedbackInput): Promise<void> {
  if (await hasFeedbackForBill(input.payerAddress, input.billId)) return;
  const agentId = await ensureAgent(input.payerAddress, input.payerWalletId);
  await scorePaidInFull({
    payerAddress: input.payerAddress,
    agentId,
    billId: input.billId,
    paymentTxHash: input.paymentTxHash,
  });
}

export type ExternalPaidFeedbackInput = {
  payerAddress: string; // the DebtPaid.payer, from the event monitor
  billId: string;
  paymentTxHash: string; // the on-chain payDebt tx hash from the notification
};

// Record "paid_in_full" for a browser/non-custodial payer seen via the
// DebtPaid event monitor. Splitsy can't sign as their wallet, so the dedicated
// REGISTRAR DCW mints their identity NFT and transfers it to them — a
// different wallet than the validator, so the no-self-scoring rule still
// holds. The registrar's wallet address never enters reputation_feedback; only
// the real payer's does, keyed to the DebtPaid it settled. Idempotent per
// (payer, bill).
export async function recordExternalPaidFeedback(input: ExternalPaidFeedbackInput): Promise<void> {
  if (await hasFeedbackForBill(input.payerAddress, input.billId)) {
    console.log(`reputation[external]: bill ${input.billId} payer ${input.payerAddress} already scored — skip`);
    return;
  }
  const registrar = await getRegistrarWallet();
  console.log(
    `reputation[external]: bill ${input.billId} payer ${input.payerAddress} — registrar ${registrar.address} (${registrar.walletId}) minting identity`,
  );
  const agentId = await ensureAgent(input.payerAddress, registrar.walletId, registrar.address);
  console.log(`reputation[external]: bill ${input.billId} payer ${input.payerAddress} — agentId ${agentId}, scoring`);
  await scorePaidInFull({
    payerAddress: input.payerAddress,
    agentId,
    billId: input.billId,
    paymentTxHash: input.paymentTxHash,
  });
  console.log(`reputation[external]: bill ${input.billId} payer ${input.payerAddress} — done`);
}

export async function recordExternalPaidFeedbackSafely(input: ExternalPaidFeedbackInput): Promise<void> {
  try {
    await recordExternalPaidFeedback(input);
  } catch (err) {
    console.error(
      `reputation: failed to record external feedback for bill ${input.billId} payer ${input.payerAddress}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

// The pay route calls this inside after(): reputation is a side effect of a
// payment that already succeeded, so it must never surface as a payment error.
export async function recordPaidFeedbackSafely(input: PaidFeedbackInput): Promise<void> {
  try {
    await recordPaidFeedback(input);
  } catch (err) {
    console.error(
      `reputation: failed to record feedback for bill ${input.billId} payer ${input.payerAddress}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

export type RecurringPaidFeedbackInput = {
  memberAddress: string; // the MemberSettled.member the cycle was collected from
  tabId: string; //         factory tab id (namespaces the storage key)
  cycle: number; //         settlementCount this collection satisfied (1-based)
  settlementTxHash: string; // the settleTab tx — the on-chain payment anchor
  dueDate: number; //       cycle-boundary Unix seconds (0 = grade as no deadline)
  shareUnits: number; //    units pulled this cycle, for amount-weighting the avg
};

// Record reputation for one member collected in one recurring-tab settlement —
// the pull-based analog of recordExternalPaidFeedback. Consent is the member's
// standing USDC approval to the tab (given when they joined); the settler merely
// triggers the pull, so like a browser payer the member never signs at collect
// time and the REGISTRAR (not the validator) mints their identity NFT. Scored
// per (member, tab, cycle) so every cycle counts once and independently.
//
// paidAt is read from the settleTab block — authoritative and identical to what
// any observer sees, never a server clock. A block read failure grades as "no
// deadline" (a clean score) rather than penalizing a member for our read miss.
export async function recordRecurringPaidFeedback(input: RecurringPaidFeedbackInput): Promise<void> {
  const storageKey = `tab:${input.tabId}:cycle:${input.cycle}`;
  if (await hasFeedbackForBill(input.memberAddress, storageKey)) {
    console.log(`reputation[recurring]: ${storageKey} member ${input.memberAddress} already scored — skip`);
    return;
  }

  let paidAt = 0;
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: input.settlementTxHash as `0x${string}` });
    const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
    paidAt = Number(block.timestamp);
  } catch (err) {
    console.error(
      `reputation[recurring]: could not read block time for ${input.settlementTxHash}:`,
      err instanceof Error ? err.message : err,
    );
  }

  const registrar = await getRegistrarWallet();
  const agentId = await ensureAgent(input.memberAddress, registrar.walletId, registrar.address);
  await commitFeedback({
    payerAddress: input.memberAddress,
    agentId,
    storageKey,
    feedbackTag: storageKey,
    paymentTxHash: input.settlementTxHash,
    ctx: { dueDate: input.dueDate, paidAt, shareUnits: input.shareUnits },
  });
  console.log(`reputation[recurring]: ${storageKey} member ${input.memberAddress} — done`);
}

export async function recordRecurringPaidFeedbackSafely(input: RecurringPaidFeedbackInput): Promise<void> {
  try {
    await recordRecurringPaidFeedback(input);
  } catch (err) {
    console.error(
      `reputation[recurring]: failed for tab ${input.tabId} cycle ${input.cycle} member ${input.memberAddress}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
