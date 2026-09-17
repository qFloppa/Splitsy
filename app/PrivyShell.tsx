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
import { getEmbeddedConnectedWallet, PrivyProvider, useExportWallet, usePrivy, useSignTransaction, useWallets } from "@privy-io/react-auth";
import { useEffect, useRef, useState } from "react";
import { ARC } from "@/lib/arc-chain";
import { forgetSigner, markPrivyUi, rememberAuth, rememberSigner, toPrivyTransaction } from "./privy-signer";

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
  const { ready, authenticated, getAccessToken, login, logout } = usePrivy();
  const { signTransaction } = useSignTransaction();
  const { exportWallet } = useExportWallet();
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

  // Trade the Privy login for a Splitsy session, and point the user's row at the
  // embedded wallet once Privy has one.
  //
  // BOTH JOBS IN ONE EFFECT, KEYED ON THE ADDRESS, because they do not happen at
  // the same moment and the first version assumed they did. `createOnLogin` builds
  // the wallet in the BROWSER after authentication, so the exchange that fires the
  // instant `authenticated` flips true reaches a Privy user with no wallet yet —
  // the session is created, the row's wallet stays null, and the panel sits on
  // "your wallet is being created" forever, because a guard that skipped the
  // exchange whenever a session existed meant it never asked again. Depending on
  // `address` is what makes it ask again: the effect re-runs when the wallet
  // appears.
  //
  // The server verifies the token itself and maps it onto the `users` row this
  // person already has (lib/privy-identity.ts); nothing sent from here is
  // trusted, and the address is read from Privy server-side rather than taken
  // from this component. After that the ~40 route handlers calling
  // getSessionUser() are untouched, which is the reason for doing it this way
  // rather than teaching every route to read a Privy token.
  //
  // THE ROW MUST NAME THE WALLET THE BROWSER ACTUALLY HOLDS, which is a stricter
  // test than "the row names a wallet" and the reason this is not a one-shot. An
  // EXISTING Splitsy account arrives here with an address already — the one from
  // the stack it used before — and skipping those left the row pointing at a
  // wallet this browser cannot sign for. The server then prepared a transaction
  // for the old wallet, Privy signed with the embedded one, and broadcastSigned
  // refused it: "Signature recovers to 0x… , not 0x…". Nothing moved, but nothing
  // worked either, and the message was internal. Existing accounts getting a NEW
  // embedded wallet at a NEW address is the settled behaviour (plan, 2026-09-12),
  // so a row that disagrees is a row to repoint, not a reason to stop.
  //
  // THE RELOAD IS CONDITIONAL ON SOMETHING HAVING CHANGED, which is what keeps it
  // from becoming a loop: a signed-in user whose wallet Privy has not created
  // asks, is told `walletAddress: null`, and stops. Reloading on a bare `ok` would
  // reload, ask again, get the same answer and reload again. It is what an OAuth
  // redirect used to do, and every panel reads /api/me on mount.
  const syncing = useRef(false);
  useEffect(() => {
    if (!ready || !authenticated || syncing.current) return;
    syncing.current = true;
    void (async () => {
      try {
        const me = await fetch("/api/me")
          .then((r) => r.json())
          .then((d: { user: { walletAddress: string | null } | null }) => d.user);
        const already = me?.walletAddress?.toLowerCase() ?? null;
        // Signed in AND the row already names the wallet this browser is holding:
        // nothing to do. When the address is not known yet the exchange still
        // runs — the server reads it from Privy itself — and the reload guard
        // below is what stops that from repeating pointlessly.
        if (me && already && address && already === address.toLowerCase()) return;

        const accessToken = await getAccessToken();
        if (!accessToken) return;
        const res = await fetch("/api/auth/privy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accessToken }),
        });
        if (!res.ok) return;
        const body = (await res.json().catch(() => ({}))) as { walletAddress?: string | null };
        const linked = body.walletAddress?.toLowerCase() ?? null;
        if (!me || (linked && linked !== already)) window.location.reload();
      } catch {
        // Left as it was rather than retried. A failed exchange is visible — the
        // header still offers sign-in, or the panel still says the wallet is on its
        // way — and a retry loop against a server that is refusing is worse than a
        // reload the user can do themselves.
      } finally {
        syncing.current = false;
      }
    })();
  }, [ready, authenticated, address, getAccessToken]);

  return null;
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
          loginMessage: "Split bills and settle in USDC on Arc Testnet.",
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
