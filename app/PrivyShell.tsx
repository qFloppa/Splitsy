"use client";

// Privy's UI, themed to Splitsy, and the wiring that publishes it to the rest of
// the app.
//
// A LEAF, NOT A WRAPPER. PrivyProvider sits beside the app rather than around it,
// which it can because nothing else in the tree calls a Privy hook — signing,
// login and logout all travel through the module-scoped spot in ./privy-signer.
// That is what lets this whole file be loaded on demand: a wrapper would have to
// be present before its children could render, and a dynamic one would blank the
// page while its chunk arrived. Privy's own modal portals to <body>, so where
// this sits in the tree makes no difference to what the user sees.
//
// Mounted only when WALLET_UI names Privy (decided on the server, in
// app/layout.tsx). Off, none of this is even fetched.
import { getEmbeddedConnectedWallet, PrivyProvider, useCreateWallet, useExportWallet, usePrivy, useSignTransaction, useWallets } from "@privy-io/react-auth";
import { useEffect, useRef, useState } from "react";
import { ARC, ARC_LABEL } from "@/lib/arc-chain";
import { bridgeAction } from "@/lib/privy-bridge";
import { forgetSigner, markPrivyUi, rememberAuth, rememberSigner, toPrivyTransaction } from "./privy-signer";

// How long the bridge keeps working at it: a pass every 2.5s for a minute. Same
// window app/XAuthControl.tsx waits for a wallet in, because they are waiting for
// the same thing — when the loop gives up, that panel is what says so.
const PASS_EVERY_MS = 2_500;
const PASSES = 24;
// Creating the wallet is asked for at most twice. It either works, or it throws
// because the user already has one (both leave `hasWallet` true on the next
// pass), or Privy is refusing — and a loop that asks twenty-four times for a key
// pair is a loop that mints wallets by accident.
const CREATE_TRIES = 2;

// Which theme the app is currently in, for the one consumer that cannot read CSS:
// Privy takes its background as a prop and generates its whole palette from it.
// Everything the CSS can reach is themed in globals.css instead, which follows
// [data-theme] with no JavaScript at all.
//
// An observer rather than lib/use-theme's useTheme, because this must only WATCH.
// useTheme owns the value — it writes the attribute and sessionStorage on mount —
// so a second owner here would fight the real toggle.
function useThemeAttribute(): "light" | "dark" {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  useEffect(() => {
    const read = () => setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light");
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

// Everything this file exists to publish. One component, three small jobs, all of
// them "take something only a Privy hook can give and put it where plain code can
// read it".
function PrivyBridge() {
  const { ready, authenticated, user, getAccessToken, login, logout } = usePrivy();
  const { signTransaction } = useSignTransaction();
  const { exportWallet } = useExportWallet();
  const { createWallet } = useCreateWallet();
  const { wallets } = useWallets();

  // Rendered only when WALLET_UI=privy, so its presence IS the flag. Set during
  // render rather than in an effect because walletPost can be called before
  // effects have run — a button pressed on an already-hydrated page beats
  // useEffect — and the wrong answer there is a payment routed down the old path.
  // Both writes are idempotent, so a double render in strict mode changes nothing.
  markPrivyUi();
  rememberAuth({ login, logout, exportWallet });

  const embedded = getEmbeddedConnectedWallet(wallets);
  const address = embedded?.address ?? null;

  // Whether PRIVY says this user has an embedded wallet at all — which is a
  // different question from `address` above. That one is "has this tab connected
  // it yet", and it is null for a few seconds on every page load; this is read
  // off Privy's own record of the account, so "no wallet" here means there is
  // genuinely nothing to connect and somebody has to make one.
  const hasWallet = (user?.linkedAccounts ?? []).some(
    (a) => a.type === "wallet" && a.connectorType === "embedded" && a.chainType === "ethereum",
  );

  useEffect(() => {
    if (!address) {
      forgetSigner();
      return;
    }
    rememberSigner(async (plan, ui) => {
      const { signature } = await signTransaction(toPrivyTransaction(plan), {
        address,
        // The branded confirmation, which is the whole point of this migration.
        // Asked for explicitly rather than left to the dashboard default: whether
        // the user sees a prompt is a promise this app makes in its own copy, and
        // a console setting somebody else can flip is not where that promise
        // should live.
        //
        // THE AMOUNT IS IN `description` BECAUSE PRIVY CANNOT WORK IT OUT HERE.
        // It does decode ERC-20 transfer and approve calldata by default, but
        // decoding gives it an integer and a token address — and on Arc Testnet
        // it has no metadata to turn 0x3600… into "USDC, 6 decimals" and no price
        // feed to convert it. Its own comment rules out asking for native-token
        // figures only, so the prompt had nothing to show. The caller decodes the
        // exact bytes about to be signed and says the number itself, which is the
        // most honest display available: it is read from the payload, not from a
        // parallel claim about it.
        uiOptions: {
          showWalletUIs: true,
          description: ui.description,
          buttonText: "Approve",
          isCancellable: true,
          transactionInfo: { title: "Payment", action: ui.action },
        },
      });
      return signature;
    });
    return forgetSigner;
  }, [address, signTransaction]);

  // Trade the Privy login for a Splitsy session, make the embedded wallet if
  // Privy has not, and point the user's row at it. One loop, because the three
  // are one job and they do not happen at the same moment.
  //
  // WHAT IT DOES AND WHY IT IS A LOOP is recorded with the measurements in
  // lib/privy-bridge.ts — two brand-new signups, one whose wallet Privy reported
  // three seconds late and one whose wallet it did not make for nineteen minutes.
  // The rules live there, pure and tested; this effect is the hands.
  //
  // The server verifies the token itself and maps it onto the `users` row this
  // person already has (lib/privy-identity.ts); nothing sent from here is
  // trusted, and the address is read from Privy server-side rather than taken
  // from this component. After that the ~40 route handlers calling
  // getSessionUser() are untouched, which is the reason for doing it this way
  // rather than teaching every route to read a Privy token.
  //
  // THE EXCHANGE IS IDEMPOTENT, which is what makes retrying it safe: it upserts
  // the same row under the same key and writes the wallet only when Privy reports
  // one (app/api/auth/privy/route.ts).
  //
  // THE LATEST FACTS COME THROUGH A REF rather than through the dependency array.
  // Keying the effect on `address` is what the old version did, and a wallet that
  // arrived while a request was in flight was then swallowed by the mutex that
  // kept two exchanges from overlapping: the re-run was the only notification,
  // and it was spent. A loop that re-reads on every pass cannot miss a signal.
  const latest = useRef({ address, hasWallet });
  useEffect(() => {
    latest.current = { address, hasWallet };
  }, [address, hasWallet]);

  // A generation counter rather than a mutex. Only the newest run may act: a
  // mutex that said "one at a time" would be held by a run the cleanup had
  // already abandoned — which is exactly what React's development double-mount
  // does on every page load, and the second mount would then find the bridge
  // "busy" forever and do nothing at all.
  const run = useRef(0);
  // What the user sees while the bridge works, in the ONE window where nothing
  // else can say anything. The login happens in Privy's modal over a page that
  // was rendered signed-out, so until the exchange lands the header still shows
  // "Sign in" and there is no wallet trigger — the modal closes onto a page that
  // looks exactly as it did before, which is the moment people assume the app is
  // broken. Deliberately NOT shown when the page already had a session: there
  // the wallet trigger is on screen and says this itself (app/XAuthControl.tsx),
  // and two chips saying the same thing is worse than one.
  const [signingIn, setSigningIn] = useState(false);
  useEffect(() => {
    if (!ready || !authenticated) return;
    const id = ++run.current;
    const live = () => run.current === id;
    void (async () => {
      let reloading = false;
      try {
        // What the page loaded with. Only used to decide whether a reload is owed
        // — every other panel read /api/me on mount, and a row that has changed
        // under them is a header still offering sign-in to someone signed in.
        const me = await fetch("/api/me")
          .then((r) => r.json())
          .then((d: { user: { walletAddress: string | null } | null }) => d.user);
        const pageRowWallet = me?.walletAddress?.toLowerCase() ?? null;
        let rowWallet = pageRowWallet;
        let creates = 0;
        if (!me && live()) setSigningIn(true);

        for (let pass = 0; pass < PASSES && live(); pass++) {
          const action = bridgeAction({
            hasWallet: latest.current.hasWallet,
            browserWallet: latest.current.address,
            rowWallet,
            pageRowWallet,
            pageHadSession: Boolean(me),
          });

          if (action === "settled") return;
          if (action === "reload") {
            // Left on screen on purpose: the page is leaving, and clearing it
            // first would put the blank back for the length of a page load.
            reloading = true;
            window.location.reload();
            return;
          }

          if (action === "create-wallet") {
            // Give up rather than ask forever: without a wallet there is nothing
            // to link, and app/XAuthControl.tsx's panel is already saying so.
            if (creates++ >= CREATE_TRIES) return;
            // Throws if the user turns out to have one already — which is the
            // happy answer, and the next pass reads it off `user.linkedAccounts`.
            await createWallet().catch(() => {});
          } else if (action === "exchange") {
            const accessToken = await getAccessToken();
            if (accessToken) {
              const res = await fetch("/api/auth/privy", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ accessToken }),
              });
              if (res.ok) {
                const body = (await res.json().catch(() => ({}))) as { walletAddress?: string | null };
                rowWallet = body.walletAddress?.toLowerCase() ?? rowWallet;
              }
            }
          }
          // "wait" does nothing at all: the next pass re-reads `latest` and the
          // tab will have connected its wallet by then.

          await new Promise((r) => setTimeout(r, PASS_EVERY_MS));
        }
      } catch {
        // Swallowed deliberately: the pass that threw is one of up to twenty-four,
        // and the panel says what the user can see for themselves. What must not
        // happen is an unhandled rejection taking the bridge down with it.
      } finally {
        if (!reloading && live()) setSigningIn(false);
      }
    })();
    // `address` and `hasWallet` are deliberately absent from the deps: they are
    // read through `latest` on every pass, and listing them would restart the
    // loop — which is the bug this shape exists to remove.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, authenticated]);

  // The chip, where the wallet trigger will be, so the two read as one thing
  // handing over to the other. It takes .wallet-hail's own pending skin (the
  // accent pill, globals.css) rather than inventing a second loader.
  if (!signingIn) return null;
  return (
    <div className="wallet-hail" data-pending="" role="status" aria-live="polite">
      <span className="wallet-hail-word">signing you in…</span>
    </div>
  );
}

export default function PrivyShell({ appId, nonce }: { appId: string; nonce?: string }) {
  const theme = useThemeAttribute();
  return (
    <PrivyProvider
      appId={appId}
      config={{
        appearance: {
          // SPLITSY'S OWN SURFACE COLOUR, not the word 'light' or 'dark'. Privy
          // takes a hex here and generates the rest of its palette —
          // foregrounds, hovers, borders, icon greys — by modulating that
          // colour's luminance, so the modal comes out as a shade of the product
          // rather than a stock white or black sheet with a brand accent poked
          // into it. The two values are --surface-strong from globals.css, which
          // is what every other floating panel in the app is painted with.
          theme: theme === "dark" ? "#132b42" : "#ffffff",
          // The brand blue, per theme, the same way globals.css resolves
          // --accent. Privy generates its light and dark variants from this.
          accentColor: theme === "dark" ? "#62a8f1" : "#2775ca",
          logo: "/splitsy.png",
          landingHeader: "Sign in to Splitsy",
          loginMessage: `Split bills and settle in USDC on ${ARC_LABEL}.`,
          // No external-wallet buttons in the login modal. A browser wallet signs
          // in through /api/auth/wallet and keeps its own keys — offering it here
          // too would be a second door to a different kind of account.
          walletList: [],
        },
        // The four Splitsy already supports, and only those: every one of them
        // maps onto an existing `users` row (lib/privy-identity.ts). Adding a
        // fifth here would let someone in through a door with no key on the other
        // side — /api/auth/privy answers 409 and they get nowhere.
        loginMethods: ["twitter", "discord", "google", "email"],
        // Arc only. Every write this app makes lands on Arc, and Privy throws on
        // a chain outside this list rather than signing for the wrong one.
        supportedChains: [ARC.chain],
        defaultChain: ARC.chain,
        embeddedWallets: {
          // Everyone gets one at login, which is what makes the pay wallet exist
          // with no setup ceremony at all. 'users-without-wallets' rather than
          // 'all-users' so someone arriving with a pregenerated wallet already
          // attached is not prompted to make a second.
          ethereum: { createOnLogin: "users-without-wallets" },
          // THE CONFIRMATION, ON, AND NOT LEFT TO THE DASHBOARD. Asked for here
          // as well as per call (app/privy-signer.ts) for the same reason.
          showWalletUIs: true,
        },
        // proxy.ts serves a strict script-src with a per-request nonce, and
        // Privy's third-party loaders are not covered by 'strict-dynamic'.
        // Without this its CAPTCHA loader is blocked and login stalls with
        // nothing on screen to say why.
        scriptNonce: nonce,
      }}
    >
      <PrivyBridge />
    </PrivyProvider>
  );
}
