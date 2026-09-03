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

// Defined in arc-explorer.ts so browser components can import it too; re-exported
// here because this is the module server code imports.
export { looksLikeTxHash } from "./arc-explorer.ts";

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
