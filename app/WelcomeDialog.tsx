"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useSignMessage } from "wagmi";
import { useEffect, useRef, useState } from "react";
import { walletSignIn } from "@/lib/agent-link";
import type { WalletSession } from "@/lib/wallet-session";
import { privyLogin } from "./privy-signer";
import { SIGNIN_PROVIDERS } from "./SignInProviders";

// The first-visit explainer on /app. It exists because the header offers two
// unrelated-looking controls — "Sign in" (social) and "Connect wallet" (a browser
// wallet) — and nothing anywhere says they are two ways to the same app, that
// either is enough, or that holding both is allowed. A visitor who has a social
// account but no extension reads "Connect wallet" as a requirement and leaves.
//
// IT TEACHES, IT DOES NOT GATE. The header keeps both controls, and closing this
// is always a complete answer — the X, Escape, the backdrop and "Maybe later" all
// do the same thing and none of them blocks. Once closed it does not return: one
// localStorage key, and a returning visitor who has not signed in meets the
// header again rather than this panel.
//
// THE TWO DOORS ARE EQUAL, deliberately: same column width, same heading weight,
// same controls. Neither is the recommended path, because on this app neither is
// — social makes a wallet for you, a browser wallet keeps its own keys, and both
// reach every tab.
const SEEN_KEY = "splitsy:welcome";

export default function WelcomeDialog({ session }: { session: WalletSession }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { signMessageAsync } = useSignMessage();

  // Read on mount rather than in the initial state, because this is a client
  // component inside a server-rendered page: reading storage during render would
  // disagree with the HTML.
  useEffect(() => {
    if (session.user) return;
    try {
      if (localStorage.getItem(SEEN_KEY)) return;
    } catch {
      // A browser refusing storage is not a reason to hide the explanation.
    }
    // Opened a frame later rather than inside the effect body: the panel is a
    // portal over a page that must paint first, and setting state synchronously
    // here would cascade a render before the app has had one.
    const id = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(id);
  }, [session.user]);

  const close = () => {
    setOpen(false);
    try {
      localStorage.setItem(SEEN_KEY, "1");
    } catch {
      // Same as above: the dismissal is best-effort, the close is not.
    }
  };

  // The wallet door's second half. ConnectButton only CONNECTS; an account needs
  // the signature, so this watches for the address the connect modal produced and
  // finishes the job. `busy` is read through a ref so a re-render mid-signature
  // cannot start a second request or cancel the first.
  const running = useRef(false);
  function finishWalletSignin(address: string) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    void walletSignIn(address, signMessageAsync)
      .then((outcome) => {
        if (!outcome.ok) {
          setError(outcome.error);
          return;
        }
        // The whole page reads /api/me on mount, so the session this just made
        // is only visible after a reload — the same move app/PrivyShell.tsx makes.
        window.location.reload();
      })
      .finally(() => {
        running.current = false;
        setBusy(false);
      });
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <Dialog.Portal>
        <Dialog.Overlay className="flow-backdrop" />
        <Dialog.Content aria-describedby="welcome-sub" className="flow-panel welcome-panel">
          <div className="bill-poster-head">
            <span className="settle-label">Welcome to Splitsy</span>
            {/* The X lives in the head, opposite the rail fact, because the foot's
                one action is "Maybe later" and two dismissals in one panel read
                as a bug. Radix wires aria-label and the Escape/backdrop closes. */}
            <Dialog.Close aria-label="Close" className="welcome-close">
              ✕
            </Dialog.Close>
          </div>
          <Dialog.Title className="flow-title">Two ways in.</Dialog.Title>
          <Dialog.Description className="bill-poster-note" id="welcome-sub">
            Use a social account or a browser wallet — either one gets you the whole app, and you can
            add the other later.
          </Dialog.Description>

          <div className="welcome-doors">
            <section className="welcome-door">
              <h3 className="settle-label">Social account</h3>
              <p className="bill-poster-note">
                Sign in with X, Discord, Google or email. Splitsy makes a wallet for you, so there is
                nothing to install.
              </p>
              {session.walletUi === "privy" ? (
                <button className="iou-provider bill-toggle" onClick={privyLogin} type="button">
                  Sign in
                </button>
              ) : (
                <div className="welcome-providers">
                  {SIGNIN_PROVIDERS.map((provider) => (
                    <a className="iou-provider bill-toggle" href={provider.href} key={provider.key}>
                      {provider.icon}
                      {provider.label}
                    </a>
                  ))}
                </div>
              )}
            </section>

            <section className="welcome-door">
              <h3 className="settle-label">Browser wallet</h3>
              <p className="bill-poster-note">
                Use the wallet in your browser. You keep its keys — sign a short message to prove it is
                yours, then you are in.
              </p>
              <ConnectButton.Custom>
                {({ account, openConnectModal }) => (
                  <button
                    className="iou-provider bill-toggle"
                    disabled={busy}
                    onClick={() => (account ? finishWalletSignin(account.address) : openConnectModal())}
                    type="button"
                  >
                    {busy
                      ? "Signing in…"
                      : account
                        ? `Sign in as ${account.displayName}`
                        : "Connect wallet"}
                  </button>
                )}
              </ConnectButton.Custom>
            </section>
          </div>

          <div className="bill-poster-foot flow-foot">
            <p
              className="bill-poster-msg"
              data-tone={error ? "error" : undefined}
              role="status"
            >
              {error ?? ""}
            </p>
            <button className="iou-provider bill-toggle" onClick={close} type="button">
              Maybe later
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
