"use client";

// Privy's embedded wallet, reachable from code that is not a React component.
//
// WHY A SHARED SPOT IN MEMORY. Privy's signing, login and logout all come out of
// React hooks, and app/signed-send.ts's walletPost is a plain function — nine
// call sites call it, none from a place that could hold a hook's result. So the
// bridge is a handful of module-scoped values, written once when the app starts
// and read at the moment they are needed. Deliberately the same shape as
// ./session-owner-key, which already holds the owner key that way and is already
// read by signedSend at signing time: one pattern to learn instead of two, and no
// call site changes.
//
// IT ALSO KEEPS THE SDK OUT OF THE BUNDLE. Nothing here imports
// @privy-io/react-auth — only app/PrivyShell.tsx does, and that is loaded on
// demand and only when WALLET_UI names Privy. Without this split, every panel
// that imports signed-send.ts would drag Privy's whole SDK into the Circle
// stack's pages, where it is dead weight.
//
// MODULE SCOPE ONLY. Never React state (a tab switch unmounts the component that
// held it), never sessionStorage or localStorage (a function is not serialisable
// and a wallet handle has no business outliving the tab).
//
// The cost is an invisible dependency — walletPost works or refuses depending on
// something no argument mentions — and that is why an absent signer is handled as
// an ordinary refusal rather than a throw. See walletPost.

// What the server prepares (lib/privy-wallet.ts:prepareTransfer) — snake_case,
// hex quantities, chain id as a number. Declared here rather than imported
// because it crosses the wire as JSON.
export type PreparedPlan = {
  to: string;
  data: string;
  nonce: string;
  chain_id: number;
  gas_limit: string;
  max_fee_per_gas: string;
  max_priority_fee_per_gas: string;
};

// Privy's UnsignedTransactionRequest is camelCase and takes hex strings as
// quantities, so this is a rename rather than a conversion. Gas fields are passed
// through: the server read them off the chain, and Privy has no Arc RPC to
// re-estimate with. lib/privy-wallet.ts:matchesPrepared re-checks the bytes that
// come back, so a signer that overrides one of these is caught server-side rather
// than trusted here.
export function toPrivyTransaction(plan: PreparedPlan) {
  return {
    to: plan.to,
    data: plan.data,
    nonce: plan.nonce,
    chainId: plan.chain_id,
    type: 2,
    gasLimit: plan.gas_limit,
    maxFeePerGas: plan.max_fee_per_gas,
    maxPriorityFeePerGas: plan.max_priority_fee_per_gas,
  };
}

// Returns the SIGNED TRANSACTION, not a signature over a payload: Privy's
// signTransaction resolves eth_signTransaction, whose answer is the serialized
// type-2 transaction. The server broadcasts it.
export type PrivySigner = (plan: PreparedPlan, description: string) => Promise<string>;

let signer: PrivySigner | null = null;
let uiActive = false;
let login: (() => void) | null = null;
let logout: (() => Promise<void>) | null = null;
let exportWallet: ((options: { address: string }) => Promise<void>) | null = null;

export function rememberSigner(fn: PrivySigner): void {
  signer = fn;
}

export function signerOrNull(): PrivySigner | null {
  return signer;
}

export function forgetSigner(): void {
  signer = null;
}

// Whether Privy's UI is the thing this deployment asks users to approve in.
//
// SEPARATE FROM THE SIGNER, because the two say different things and the
// difference is what the user is told. No signer with the UI off is the old
// world, and walletPost should take the path it always did. No signer with the UI
// ON means Privy is not ready or the user is not logged into it — a state the
// user can fix, and one that must not silently fall through to asking the server
// to sign a wallet it holds no key to.
export function privyUiActive(): boolean {
  return uiActive;
}

export function markPrivyUi(): void {
  uiActive = true;
}

export function rememberAuth(fns: {
  login: () => void;
  logout: () => Promise<void>;
  exportWallet: (options: { address: string }) => Promise<void>;
}): void {
  login = fns.login;
  logout = fns.logout;
  exportWallet = fns.exportWallet;
}

// Open Privy's login modal. No-op before the shell has loaded, which is the right
// answer for a button pressed in the first moment of a page: nothing has been
// promised yet, and the user presses it again.
export function privyLogin(): void {
  login?.();
}

// Show the user their embedded wallet's private key, in PRIVY'S OWN WINDOW.
//
// The key is rendered in an iframe on Privy's domain, so it never enters this
// app's page and Splitsy cannot read it — which is the whole reason this is
// Privy's modal rather than a screen of ours. Splitsy's own export ceremony
// (app/ExportTab.tsx) is for wallets Splitsy minted and has nothing to do with
// this one.
//
// Resolves when the user closes the modal, and throws if Privy has no embedded
// wallet for them; the caller shows the message rather than assuming success.
export async function privyExportWallet(address: string): Promise<void> {
  if (!exportWallet) throw new Error("Your wallet isn't connected yet — reload and try again.");
  await exportWallet({ address });
}

// End the Privy session too. Splitsy's own sign-out clears its cookie, and
// without this the bridge would see a live Privy login on the next page load and
// hand the user straight back a session they just ended.
export async function privyLogout(): Promise<void> {
  await logout?.().catch(() => {});
}
