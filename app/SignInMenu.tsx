"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useCallback, useEffect } from "react";
import { useAccount, useAccountEffect } from "wagmi";
import { isStaleWalletSession, SESSION_ENDED_EVENT } from "@/lib/agent-link";
import type { WalletSession } from "@/lib/wallet-session";
import { privyLogin } from "./privy-signer";
import { SIGNIN_PROVIDERS } from "./SignInProviders";

// Single header entry point for all sign-in methods — collapses the four
// per-provider buttons into one "Sign in" dropdown so the header isn't crowded.
// Once signed in the floating wallet widget (XAuthControl) takes over, so this
// renders null. X/Discord/Google are plain OAuth-start links; Email routes to
// its own page (the OTP flow needs room).
//
// SOCIAL LOGINS ONLY. A browser wallet is not one of them and never renders as
// one here: it already has an account control in the header — the ConnectButton
// beside this one — and a second chip repeating the same address made the wallet
// read as a Splitsy-managed identity it is not. So a wallet session shows this
// dropdown exactly as a signed-out visitor does, because holding keys is not the
// same as having a social login and they must still be able to add one. What
// signs a wallet out is disconnecting in the extension (see useAccountEffect).
const ITEM_CLASS =
  "flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium text-[var(--text)] no-underline outline-none transition data-[highlighted]:bg-[var(--surface-muted)]";

export default function SignInMenu({ session }: { session: WalletSession }) {
  // The account, from the server, with the page (lib/wallet-session.ts). This
  // control used to fetch /api/me from a mount effect and render NOTHING until it
  // answered — so a signed-out visitor got no sign-in button, and a signed-in one
  // got no account control, for as long as the app took to hydrate and ask.
  const me = session.user;
  // Whether Privy's modal is the door on this deployment (WALLET_UI). Read from
  // the server alongside the session, so signed-out visitors get the right one —
  // which is exactly when it matters.
  const privyUi = session.walletUi === "privy";
  const { address } = useAccount();

  // Drop a wallet session the browser no longer backs, and say so out loud.
  //
  // The session is re-read from the server rather than taken from `me` above:
  // signing in with a wallet happens inside the Agents tab and deliberately does
  // NOT reload the page, so this component's snapshot can still say "signed out"
  // while a wallet session is live — and reconciling off that stale value
  // no-ops at exactly the moment it is needed.
  //
  // The event, rather than a reload, is what tells the Agents tab to stop showing
  // the old account's caps, decision log and agent balance. A reload did that too,
  // but it also dropped the user back on the default tab. Announced only once the
  // server confirms the cookie is gone, so a failed logout changes nothing.
  const reconcile = useCallback(async (wallet: { connected: boolean; address?: string }) => {
    const session = await fetch("/api/me")
      .then((r) => r.json())
      .then((d: { user: { provider?: string | null; handle: string } | null }) => d.user)
      .catch(() => null);
    if (!isStaleWalletSession(session, wallet)) return;
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    const signedOut = await fetch("/api/me")
      .then((r) => r.json())
      .then((d: { user: unknown }) => !d.user)
      .catch(() => false);
    // `me` is deliberately left as it was: a wallet session and a signed-out
    // visitor render the same dropdown here, so there is nothing to re-render,
    // and nothing above reads it — reconcile asks the server precisely because
    // that snapshot cannot be trusted.
    if (signedOut) window.dispatchEvent(new Event(SESSION_ENDED_EVENT));
  }, []);

  // Disconnecting IS signing out for a wallet account — it owns no chip in the
  // header, so the extension's own disconnect is the only way out and has to
  // actually end the session rather than leave a 30-day cookie behind.
  //
  // wagmi's transition callback, not the raw status: the store starts at
  // 'disconnected' and only flips to 'reconnecting' once reconnect() runs from a
  // mount effect, so reading status directly would sign every wallet user out on
  // every page load. onDisconnect fires on connected → disconnected alone.
  //
  // ponytail: a wallet that never reconnects (site permission revoked) leaves the
  // session in place, since no transition happens. Connecting any wallet resolves
  // it — the same one keeps the session, a different one drops it below.
  const onDisconnect = useCallback(() => void reconcile({ connected: false }), [reconcile]);
  useAccountEffect({ onDisconnect });

  // The other way a wallet session outlives its truth: the extension switches to
  // a different account, so the session names someone else. The Agents tab then
  // offers "Sign in with <the new address>". A missing address is not a switch —
  // it is wagmi still hydrating, or the disconnect the callback above owns.
  useEffect(() => {
    if (address) void reconcile({ connected: true, address });
  }, [address, reconcile]);

  // Signed in SOCIALLY — the floating wallet widget is that account's control, so
  // a second one here would be a duplicate. A wallet session falls through to the
  // dropdown instead: holding keys is not the same as having a social login, and
  // someone who signed in with a wallet must still be able to add one.
  if (me && me.provider !== "wallet") return null;

  // ONE BUTTON INSTEAD OF FOUR when Privy owns the door. The same four providers
  // are behind it — the Privy modal is configured with exactly X, Discord, Google
  // and email (app/PrivyShell.tsx) — so nothing is lost, and having both would be
  // two doors to the same account through different plumbing.
  //
  // privyLogin() rather than usePrivy(), deliberately: a hook here would pull
  // Privy's whole SDK into the header on every deployment, including the ones
  // where this branch never runs. It reads the same module-scoped spot the signer
  // uses, and no-ops harmlessly in the moment before the shell has loaded.
  if (privyUi) {
    return (
      <button className="iou-provider bill-toggle" type="button" onClick={privyLogin}>
        Sign in
      </button>
    );
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        {/* A mark on the header rail, not a filled pill. The rule draws while the
            menu is open — the same gesture every other control in this header
            makes to say it is the live one. The provider logos stay inside the
            menu, where each one names a different destination; a lock glyph on
            the trigger only re-said the word next to it. */}
        <button className="iou-provider bill-toggle" type="button">
          Sign in
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={10}
          className="z-[80] w-60 rounded-xl border border-[var(--pay-poster-rule)] bg-[var(--surface-strong)] p-1.5 shadow-lg"
        >
          <DropdownMenu.Label className="settle-label block px-2.5 py-1.5">Sign in with</DropdownMenu.Label>

          {SIGNIN_PROVIDERS.map((provider) => (
            <DropdownMenu.Item asChild key={provider.key}>
              <a href={provider.href} className={ITEM_CLASS}>
                {provider.icon}
                {provider.label}
              </a>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
