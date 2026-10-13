// What the Privy bridge should do next, as a function of four facts. The bridge
// itself (app/PrivyShell.tsx) is then a loop that does what this says.
//
// WHY THIS IS A FUNCTION AND NOT FOUR `if`s IN AN EFFECT. Measured on the live
// deployment, 2026-10-13, two brand-new email signups:
//
//   noway@splitsy.xyz   login 11:15:13 · Privy made the wallet 11:15:12 ·
//                       the exchange at 11:15:15 was told the user had NO wallet ·
//                       the row only named it at 11:16:56, after a manual reload
//   noway2@splitsy.xyz  login 11:19:59 · Privy made the wallet 11:39:10 —
//                       NINETEEN MINUTES later. Reloads in between changed
//                       nothing, because `createOnLogin` fires on LOGIN and a
//                       reloaded page is not a login.
//
// So three things are true at once, and the old effect assumed none of them:
//
//   1. Privy's server-side user record LAGS the wallet it already has. Asking
//      once, at login, can be told "no wallet" about a wallet that exists. The
//      answer is to keep asking, which the old effect could not: it fired once
//      per dependency change and held a mutex that swallowed the re-run the
//      arriving address triggered. A reload was the only cure, by hand.
//   2. The browser may never create the wallet. `createOnLogin` is the fast path,
//      not a guarantee — so the app has to be able to create one itself, which is
//      the one action that was missing entirely.
//   3. RELOADING WHILE THE WALLET IS BEING MADE IS DESTRUCTIVE. The old effect
//      reloaded the instant it created the session for a new signup — inside the
//      seconds Privy spends generating the key in its iframe — and after that
//      reload nothing would ever trigger creation again. Hence rule 4 below: a
//      reload is reachable only once a wallet exists AND the row names it.
export type BridgeFacts = {
  // Does PRIVY's record of this user name an embedded Ethereum wallet? Not the
  // same question as `browserWallet`, which is "has this tab connected it yet".
  hasWallet: boolean;
  // The address this tab can actually sign with, once the wallet has loaded.
  browserWallet: string | null;
  // What the Splitsy row names right now, as far as the loop knows.
  rowWallet: string | null;
  // What it named when the page loaded, and whether there was a session at all.
  // Both only decide whether a RELOAD is owed: every other panel in the app read
  // /api/me once, on mount, and a row that has changed under them is a header
  // still offering sign-in to someone who is signed in.
  pageRowWallet: string | null;
  pageHadSession: boolean;
};

export type BridgeAction =
  // Ask Privy to make the embedded wallet. Nothing else can help this user.
  | "create-wallet"
  // Trade the Privy token for a Splitsy session and let the server link whatever
  // wallet Privy reports. Idempotent, which is what makes retrying it safe.
  | "exchange"
  // Nothing to do THIS pass, and not finished either: the tab has not connected
  // the wallet yet, so the one comparison that matters cannot be made.
  | "wait"
  // The row and the browser agree, and the rest of the app is holding a stale
  // answer. One reload, now that it cannot interrupt anything.
  | "reload"
  // Nothing left to do.
  | "settled";

export function bridgeAction(facts: BridgeFacts): BridgeAction {
  const { hasWallet, browserWallet, rowWallet, pageRowWallet, pageHadSession } = facts;
  const row = rowWallet?.toLowerCase() ?? null;
  const browser = browserWallet?.toLowerCase() ?? null;
  const page = pageRowWallet?.toLowerCase() ?? null;

  if (!hasWallet) return "create-wallet";
  if (!row) return "exchange";
  // THE ROW MUST NAME THE WALLET THE BROWSER HOLDS, which is stricter than "the
  // row names a wallet" and the reason an existing account arriving on this stack
  // is re-pointed: the server would otherwise prepare transactions for the old
  // address, Privy would sign with the embedded one, and broadcastSigned would
  // refuse the result — "Signature recovers to 0x…, not 0x…", nothing moved and
  // nothing worked.
  //
  // SO A TAB THAT HAS NOT CONNECTED ITS WALLET YET IS NOT FINISHED, it is early.
  // Declaring victory here is how the old shape left those rows pointing at the
  // previous stack's wallet: `address` is null for the first seconds of every
  // page load, and "the row names something" was mistaken for "the row is right".
  // The exception is a page that loaded signed out — that user needs to SEE their
  // session, and the reloaded page makes this same comparison with a session in
  // hand, so the check is deferred rather than skipped.
  if (!browser) return pageHadSession ? "wait" : "reload";
  if (row !== browser) return "exchange";
  if (!pageHadSession || row !== page) return "reload";
  return "settled";
}
