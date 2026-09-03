// Which wallet backend this deployment signs with. Two live implementations,
// selected per deployment rather than per user. WHICH HOST RUNS WHICH STACK IS
// docs/deployments.md, deliberately not named here: hostnames move — handing
// splitsy.xyz to the Privy stack is Task 8 and has not happened — and a comment
// that names them goes stale silently, which is worse than one that names none,
// because this is the first file someone opens to ask. Design:
// docs/superpowers/specs/2026-09-01-privy-wallet-stack-design.md
//
// Backends are LAZY-IMPORTED so a request only ever loads the SDK it needs, and
// so unit tests can import this module without either one. Same reason
// lib/wallet-resolve.ts defers its imports.
//
// This is the one static import, and it is deliberately the dependency-free one:
// lib/arc-explorer.ts is browser-safe, so importing it here costs nothing that
// was not already loaded, and txFate below has to be able to read a reference's
// shape before it decides whether to load a backend at all.
import { looksLikeTxHash } from "./arc-explorer.ts";

export type ProviderWallet = { address: string; walletId: string };

// txHash is null when the backend has accepted the transaction but cannot yet
// name it. Circle returns an internal id first and the hash only after polling;
// Privy returns the hash directly. Callers that persist one of these must use
// looksLikeTxHash to tell which they were handed.
export type TxResult = { id: string; state: string; txHash: string | null };

export type WalletTx = {
  id: string;
  direction: "in" | "out";
  amount: string;
  address: string; // counterparty
  state: string;
  txHash: string | null;
  date: string;
};

export type WalletBackend = {
  getOrCreateWallet: (namespace: string, key: string) => Promise<ProviderWallet | null>;
  transferUsdc: (walletId: string, to: string, amountUsdc: string) => Promise<TxResult>;
  executeContract: (
    walletId: string,
    to: `0x${string}`,
    callData: `0x${string}`,
    pollMs?: number,
  ) => Promise<TxResult>;
  listTransactions: (walletId: string, address: string) => Promise<WalletTx[]>;
};

// Exact match only, and circle is the default. Anything else — a typo, a
// capitalised value, an unset var in a new environment — must land on the stack
// whose money is worthless, never on the one holding real USDC.
export function walletProviderName(): "circle" | "privy" {
  return process.env.WALLET_PROVIDER === "privy" ? "privy" : "circle";
}

// The same answer as a proper noun, for the messages that used to hard-code
// "Circle" for a failure either stack can produce. NAMED rather than made neutral:
// "not configured" is an operator's problem and the operator needs to know WHICH
// set of variables is missing — and naming it keeps the default stack's wording
// byte-identical to what it has always been.
export function walletProviderLabel(): "Circle" | "Privy" {
  return walletProviderName() === "privy" ? "Privy" : "Circle";
}

async function backend(): Promise<WalletBackend> {
  return walletProviderName() === "privy"
    ? (await import("./privy-wallet.ts")).backend
    : (await import("./circle-dcw.ts")).backend;
}

export async function getOrCreateWallet(namespace: string, key: string) {
  return (await backend()).getOrCreateWallet(namespace, key);
}
export async function transferUsdc(walletId: string, to: string, amountUsdc: string) {
  return (await backend()).transferUsdc(walletId, to, amountUsdc);
}
export async function executeContract(
  walletId: string,
  to: `0x${string}`,
  callData: `0x${string}`,
  pollMs?: number,
) {
  return (await backend()).executeContract(walletId, to, callData, pollMs);
}
export async function listTransactions(walletId: string, address: string) {
  return (await backend()).listTransactions(walletId, address);
}

// What the chain can PROVE about one transaction, for a caller holding a hash and
// no receipt. "unknown" is not a failure mode, it is the honest answer when the
// chain has nothing to say — see fateFromReads in lib/privy-wallet.ts.
export type TxFate = "success" | "reverted" | "dropped" | "unknown";

// Ask the chain about a settlement reference a row stored.
//
// The SHAPE of the reference is the whole gate, not walletProviderName(): on the
// circle stack `paid_tx_hash` holds a Circle transaction UUID, never 0x + 64 hex,
// so that stack answers "unknown" here without an RPC call and without loading the
// Privy backend at all — and keeps the 409 and the webhook it has today. Gating on
// the shape rather than the provider is also what makes a mixed .env.local (both
// vendors' credentials, one database) answer correctly instead of stranding a row:
// a chain hash names a chain transaction whoever wrote it.
//
// Lazy-imported for the same reason backend() is: a request must only load the SDK
// it needs.
export async function txFate(ref: string | null): Promise<TxFate> {
  if (!looksLikeTxHash(ref)) return "unknown";
  return (await import("./privy-wallet.ts")).fateOfTx(ref as `0x${string}`);
}

// What to do with a debt row stuck at `settling`, given that answer.
//
// Only "retry" reopens the debt, and only the two fates that PROVE the money can
// never move get it: a revert is on chain and final, and a dropped transaction lost
// its nonce slot to other bytes. Everything else keeps the row where it is, because
// the failure this is here to prevent — app/api/debts/[id]/pay sending a second bare
// transfer for a debt whose first one is still in flight — is the one that cannot be
// undone.
export function settlingVerdict(fate: TxFate): "paid" | "retry" | "wait" {
  if (fate === "success") return "paid";
  return fate === "reverted" || fate === "dropped" ? "retry" : "wait";
}

// Defined in arc-explorer.ts so browser components can import it too; re-exported
// here because this is the module server code imports.
export { looksLikeTxHash };

export class InsufficientFundsError extends Error {
  // Plain assignment, not a constructor parameter property: this module is
  // imported by unit tests, and --experimental-strip-types rejects those.
  constructor() {
    super("insufficient_funds");
    this.name = "InsufficientFundsError";
  }
}

// Whether a throw happened AFTER the backend accepted the transaction, so the
// caller must assume it may still mine. Absence means never-broadcast, which is
// the safe default — the only answer that never invents a settlement.
//
// Read through a predicate rather than as a bare property test at each call
// site, for the same reason as lib/settler.ts's isIndeterminate: this decides
// whether a settlement is logged as spent, and a typo would silently pick the
// wrong row.
export const isBroadcast = (e: unknown): boolean => (e as { broadcast?: boolean })?.broadcast === true;

// The chain hash such a throw carries, when it carries one.
//
// Both backends set the same `broadcast` tag and only one of them can name the
// transaction: the circle backend tags a failed POLL (lib/circle-dcw.ts:145), at
// which point it has Circle's id and no hash, while the privy backend attaches the
// hash it broadcast itself. So the presence of a hash tells the two apart without
// asking which provider is running — which is what lets a caller act on the privy
// case and leave the circle one exactly as it was. looksLikeTxHash rather than a
// bare truthiness test, because a caller that persists this is writing something
// an explorer has to resolve.
export const broadcastTxHash = (e: unknown): string | null => {
  const hash = (e as { txHash?: unknown })?.txHash;
  return typeof hash === "string" && looksLikeTxHash(hash) ? hash : null;
};
