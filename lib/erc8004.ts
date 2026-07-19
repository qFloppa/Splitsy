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
//      a dedicated REGISTRAR DCW mints the identity NFT on their behalf; the
//      payer→agent binding stays verifiable via the feedbackHash below.
//
// Per ERC-8004 an agent's owner cannot score its own agent, so feedback comes
// from a dedicated validator DCW, and the registrar is a THIRD distinct wallet
// (registrar owns externally-paid agents, so it can't also be the scorer).
// Each feedback commits feedbackHash = keccak256("splitsy:bill:<id>:<payTx>"),
// so anyone can re-verify a score against the DebtPaid event it claims to score.
import { createPublicClient, decodeEventLog, encodeFunctionData, http, keccak256, toHex } from "viem";
import { arcTestnet } from "viem/chains";
import { executeContractOnArc, getOrCreateArcWallet } from "./circle-dcw.ts";
import {
  getAgentByWallet,
  hasFeedbackForBill,
  insertAgent,
  insertFeedback,
} from "./reputation-repo.ts";

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

// Upload ERC-8004 agent metadata to IPFS via Pinata. Returns ipfs:// URI or
// falls back to data: URI if Pinata is unconfigured (reputation still works,
// just without discoverable off-chain metadata).
async function uploadMetadataToIPFS(walletAddress: string): Promise<string> {
  if (!PINATA_JWT) {
    const fallback = {
      name: "Splitsy payer",
      description: "Payment reputation agent for Splitsy bill-splitting app",
      agent_type: "splitsy-payer",
      version: "1",
      wallet: walletAddress,
    };
    return `data:application/json,${encodeURIComponent(JSON.stringify(fallback))}`;
  }

  const metadata = {
    name: `Splitsy Payer ${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`,
    description: "Payment reputation agent for Splitsy bill-splitting app on Arc Testnet",
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
// pay directly on-chain and never hand Splitsy a wallet to sign with. It must
// be a THIRD wallet, distinct from both payer wallets and the validator: the
// registrar ends up owning every externally-paid agent, and ERC-8004 forbids an
// agent's owner from scoring it — so the validator, not the registrar, scores.
// Faucet-funded once for gas, same as the validator (see README).
async function getRegistrarWallet() {
  const wallet = await getOrCreateArcWallet("splitsy", "reputation-registrar");
  if (!wallet) throw new Error("Circle is not configured — no registrar wallet");
  return wallet;
}

// Wallet → agentId, registering the identity NFT on first use. Lazy on
// purpose: registration is a tx paid by the member's wallet, and the only
// caller is the post-payment hook — at which point the wallet demonstrably
// holds USDC for gas.
export async function ensureAgent(
  walletAddress: string,
  circleWalletId: string,
): Promise<string> {
  const existing = await getAgentByWallet(walletAddress);
  if (existing) return existing.agent_id;

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
  const receipt = await publicClient.getTransactionReceipt({ hash: tx.txHash as `0x${string}` });
  const mint = receipt.logs.find(
    (log) =>
      log.address.toLowerCase() === IDENTITY_REGISTRY.toLowerCase() &&
      log.topics[0] === TRANSFER_TOPIC &&
      log.topics.length === 4,
  );
  if (!mint) throw new Error("agent registration receipt has no Transfer log");
  const agentId = BigInt(mint.topics[3]!).toString();

  await insertAgent({ wallet_address: walletAddress, agent_id: agentId, register_tx: tx.txHash });
  return agentId;
}

export type PaidFeedbackInput = {
  payerAddress: string;
  payerWalletId: string;
  billId: string; // on-chain BillSplitRegistry bill id
  paymentTxHash: string; // the payDebt tx — the consent anchor
};

// giveFeedback(score=100, "paid_in_full") from the validator wallet, then
// mirror the row for display. Shared by both payment paths; the caller has
// already resolved the payer's agentId (registered by whichever wallet is
// appropriate). Idempotent guard lives in the callers.
async function scorePaidInFull(input: {
  payerAddress: string;
  agentId: string;
  billId: string;
  paymentTxHash: string;
}): Promise<void> {
  const validator = await getValidatorWallet();
  const tag = "paid_in_full";
  const feedbackHash = keccak256(toHex(`splitsy:bill:${input.billId}:${input.paymentTxHash}`));
  const callData = encodeFunctionData({
    abi: ERC8004_ABI,
    functionName: "giveFeedback",
    args: [
      BigInt(input.agentId),
      100n,
      0,
      tag,
      `bill:${input.billId}`,
      `tx:${input.paymentTxHash}`,
      "",
      feedbackHash,
    ],
  });
  const tx = await executeContractOnArc(validator.walletId, REPUTATION_REGISTRY, callData);

  await insertFeedback({
    wallet_address: input.payerAddress,
    agent_id: input.agentId,
    bill_id: input.billId,
    score: 100,
    tag,
    payment_tx: input.paymentTxHash,
    feedback_tx: tx.txHash,
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
// REGISTRAR DCW mints their identity NFT — a different wallet than the
// validator, so the no-self-scoring rule still holds. The registrar's wallet
// address never enters reputation_feedback; only the real payer's does, keyed
// to the DebtPaid it settled. Idempotent per (payer, bill).
export async function recordExternalPaidFeedback(input: ExternalPaidFeedbackInput): Promise<void> {
  if (await hasFeedbackForBill(input.payerAddress, input.billId)) {
    console.log(`reputation[external]: bill ${input.billId} payer ${input.payerAddress} already scored — skip`);
    return;
  }
  const registrar = await getRegistrarWallet();
  console.log(
    `reputation[external]: bill ${input.billId} payer ${input.payerAddress} — registrar ${registrar.address} (${registrar.walletId}) minting identity`,
  );
  const agentId = await ensureAgent(input.payerAddress, registrar.walletId);
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
