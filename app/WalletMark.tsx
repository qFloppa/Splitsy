"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";

// The wallet, on the rail. RainbowKit's own ConnectButton is a filled pill with a
// shadow and a chain glyph — the last boxed control in the header — so this
// renders its three states as marks instead: the way in, the chain to fix, or the
// account you are signed in as.
//
// The chain glyph is not replaced. It was an unlabelled icon for a single-chain
// app that stamps "Arc Testnet" under its own logo, and the only chain state worth
// a word in the header is the one that stops a payment going through.
//
// Its own file rather than HomeClient's, because /pay's header wants the same
// mark and HomeClient is a 5,000-line client module — importing one 30-line
// control out of it would pull the whole app into a public share link's bundle.
export default function WalletMark() {
  return (
    <ConnectButton.Custom>
      {({ account, chain, mounted, openAccountModal, openChainModal, openConnectModal }) => {
        // Pre-hydration there is no truthful answer, and "connect a wallet" shown
        // to someone already connected is worse than a beat of nothing.
        if (!mounted) return null;
        if (!account || !chain) {
          return (
            <button className="iou-provider bill-toggle" onClick={openConnectModal} type="button">
              Connect wallet
            </button>
          );
        }
        if (chain.unsupported) {
          return (
            <button className="iou-provider bill-toggle app-warn" onClick={openChainModal} type="button">
              Wrong network
            </button>
          );
        }
        return (
          <button className="iou-provider bill-toggle" onClick={openAccountModal} type="button">
            {account.displayName}
          </button>
        );
      }}
    </ConnectButton.Custom>
  );
}
