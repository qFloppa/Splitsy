// The session as the two header controls need it, read on the SERVER so they can
// be painted with the page instead of after it.
//
// WHY THIS EXISTS. Both controls — the floating wallet trigger
// (app/XAuthControl.tsx) and the sign-in menu beside it (app/SignInMenu.tsx) —
// used to fetch /api/me from a mount effect and render NOTHING until it
// answered. On a first sign-in that is three to four seconds of a header with no
// account control and no wallet button: the page is there, the user is signed in,
// and the one surface that proves it is blank. It reads as a broken app, and no
// amount of spinner makes a blank honest when the answer was available before the
// HTML was sent.
//
// So the answer travels with the HTML. The page awaits this once, hands it to the
// client tree as a prop, and the controls render in the first paint — with the
// right account, or correctly as a signed-out visitor. Neither one fetches on
// mount any more.
//
// ONE MAPPING, TWO READERS. /api/me answers the same shape (plus the handle slots
// only the settle deck needs), and it builds it with walletSessionUser below
// rather than a second copy of the field list — a drifting copy is how a panel
// comes to be missing the one field it needed.
import type { AccountProvider, AppUser } from "@/lib/types";
import { walletProviderLabel, walletUiName } from "@/lib/wallet-provider";

export type WalletSessionUser = {
  id: string;
  provider?: AccountProvider | null;
  providerUserId?: string | null;
  handle: string;
  name: string | null;
  avatarUrl: string | null;
  walletAddress: string | null;
  // Which custodian holds this wallet's keys. An env read, not a per-user fact,
  // but the panel says it out loud and cannot read the environment itself.
  custodian: "Circle" | "Privy";
};

export type WalletSession = {
  user: WalletSessionUser | null;
  // Whether Privy's own modal is the door on this deployment (WALLET_UI). Needed
  // while signed OUT too — it decides whether the menu opens Privy or the four
  // OAuth links — which is why it sits outside `user`.
  walletUi: string;
};

export function walletSessionUser(user: AppUser): WalletSessionUser {
  return {
    id: user.id,
    provider: user.provider,
    // NOT decoration and not a secret: it is the user's own public id at their
    // provider, and the wallet setup ceremony salts the keys that will OWN the
    // wallet with (provider, providerUserId). See lib/export-crypto.ts.
    providerUserId: user.provider_user_id,
    handle: user.handle,
    name: user.name,
    avatarUrl: user.avatar_url,
    walletAddress: user.wallet_address,
    custodian: walletProviderLabel(),
  };
}

// Server-only: reads the session cookie. Called from a page, never from a client
// component.
//
// A FAILED READ IS A SIGNED-OUT PAGE, NOT A BROKEN ONE. This moved a database
// read from a client fetch into the page's own render, and the two have very
// different failure modes: /api/me falling over cost the controls their account
// and nothing else, while a throw here would be a 500 for the whole route. The
// catch keeps the old blast radius — the header shows sign-in, every panel still
// loads, and the next request is fine.
export async function walletSession(): Promise<WalletSession> {
  const { getSessionUser } = await import("@/lib/session");
  const user = await getSessionUser().catch(() => null);
  return { user: user ? walletSessionUser(user) : null, walletUi: walletUiName() };
}
