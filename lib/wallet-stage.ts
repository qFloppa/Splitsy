// Which of three screens the wallet panel opens on, given a user's row.
//
// A SOCIAL LOGIN'S WALLET DOES NOT EXIST AT THE MOMENT THE LOGIN DOES. Privy's
// `createOnLogin` builds the embedded wallet in the BROWSER after authentication
// and app/PrivyShell.tsx points the row at it a round trip later; the Circle
// stack mints at login and records the address the same way. So a signed-in user
// whose row names no wallet is NORMAL for a few seconds on both stacks — and is
// a different thing from a missing wallet on the stack that runs Splitsy's own
// provisioning ceremony, where nothing arrives on its own because the user has a
// form to fill in first.
//
// The panel could not tell those apart, so it treated every wallet-less account
// as the working case: tab rail, an em dash where the balance goes, and a line
// asking the user to refresh. A new user's first look at their own wallet was a
// control with no address in it and no sign that anything was happening.
//
// Pure, and out here rather than inline in the component, because the branch
// decides between asking for a password, waiting, and the real thing — and the
// two wrong answers are a key-making form for a wallet that already exists and a
// spinner that never ends.
export type WalletStage =
  // The row names an address: balance, send, receive, export.
  | "ready"
  // No wallet, and none is coming until the user makes the keys that will own it
  // (app/XAuthControl.tsx:WalletSetupGate → /api/wallet/provision).
  | "setup"
  // No wallet YET. Somebody else is making it; the panel's job is to say so.
  | "waiting";

export function walletStage(
  me: { walletAddress: string | null; custodian?: "Circle" | "Privy" },
  privyUi: boolean,
): WalletStage {
  if (me.walletAddress) return "ready";
  // Privy's keys behind Splitsy's screens. With Privy's own UI on, the embedded
  // wallet is created at login instead and there is no ceremony to run — so the
  // same missing address means "wait", not "fill this in".
  if (me.custodian === "Privy" && !privyUi) return "setup";
  return "waiting";
}
