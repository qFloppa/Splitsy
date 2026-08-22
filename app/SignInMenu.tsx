"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Mail } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useAccount, useAccountEffect } from "wagmi";
import { isStaleWalletSession, SESSION_ENDED_EVENT } from "@/lib/agent-link";

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

export default function SignInMenu() {
  const [me, setMe] = useState<{ provider?: string | null; handle: string } | null | undefined>(undefined);
  const { address } = useAccount();

  useEffect(() => {
    let active = true;
    fetch("/api/me")
      .then((r) => r.json())
      .then((d: { user: { provider?: string | null; handle: string } | null }) => {
        if (active) setMe(d.user);
      })
      .catch(() => {
        if (active) setMe(null);
      });
    return () => {
      active = false;
    };
  }, []);

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

  if (me === undefined) return null; // still loading
  // Signed in SOCIALLY — the floating wallet widget is that account's control, so
  // a second one here would be a duplicate. A wallet session falls through to the
  // dropdown instead: holding keys is not the same as having a social login, and
  // someone who signed in with a wallet must still be able to add one.
  if (me && me.provider !== "wallet") return null;

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

          <DropdownMenu.Item asChild>
            <a href="/api/auth/twitter" className={ITEM_CLASS}>
              <Image src="/x.png" alt="" width={16} height={16} />
              X
            </a>
          </DropdownMenu.Item>

          <DropdownMenu.Item asChild>
            <a href="/api/auth/discord" className={ITEM_CLASS}>
              <svg width="16" height="16" viewBox="0 0 127.14 96.36" fill="#5865f2" aria-hidden="true">
                <path d="M107.7 8.07A105.15 105.15 0 0 0 81.47 0a72.06 72.06 0 0 0-3.36 6.83 97.68 97.68 0 0 0-29.11 0A72.37 72.37 0 0 0 45.64 0a105.89 105.89 0 0 0-26.25 8.09C2.79 32.65-1.71 56.6.54 80.21a105.73 105.73 0 0 0 32.17 16.15 77.7 77.7 0 0 0 6.89-11.11 68.42 68.42 0 0 1-10.85-5.18c.91-.66 1.8-1.34 2.66-2a75.57 75.57 0 0 0 64.32 0c.87.71 1.76 1.39 2.66 2a68.68 68.68 0 0 1-10.87 5.19 77 77 0 0 0 6.89 11.1 105.25 105.25 0 0 0 32.19-16.14c2.64-27.38-4.51-51.11-18.9-72.15ZM42.45 65.69C36.18 65.69 31 60 31 53s5-12.74 11.43-12.74S54 46 53.89 53s-5.05 12.69-11.44 12.69Zm42.24 0C78.41 65.69 73.25 60 73.25 53s5-12.74 11.44-12.74S96.23 46 96.12 53s-5.04 12.69-11.43 12.69Z" />
              </svg>
              Discord
            </a>
          </DropdownMenu.Item>

          <DropdownMenu.Item asChild>
            <a href="/api/auth/google" className={ITEM_CLASS}>
              <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
                <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
                <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
                <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
                <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
              </svg>
              Google
            </a>
          </DropdownMenu.Item>

          <DropdownMenu.Item asChild>
            <Link href="/signin/email" className={ITEM_CLASS}>
              <Mail size={16} />
              Email
            </Link>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
