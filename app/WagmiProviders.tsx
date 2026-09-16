"use client";

import "@rainbow-me/rainbowkit/styles.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider } from "@rainbow-me/rainbowkit";
import dynamic from "next/dynamic";
import { WagmiProvider } from "wagmi";
import { wagmiConfig } from "@/lib/wagmi";
import { markPrivyUi } from "./privy-signer";

const queryClient = new QueryClient();

// Privy's SDK is large and is dead weight on the Circle stack, so it is fetched
// only when WALLET_UI names it — which is why ./PrivyShell is a LEAF beside the
// app rather than a provider around it. Nothing waits on this chunk: the shell
// renders null until it arrives, Privy's modal portals to <body> regardless, and
// the module-scoped spot in ./privy-signer is what the rest of the app reads.
//
// ssr: false because every hook in there is browser-only.
const PrivyShell = dynamic(() => import("./PrivyShell"), { ssr: false });

export default function WagmiProviders({
  children,
  privyAppId,
  nonce,
}: {
  children: React.ReactNode;
  // Non-empty only when WALLET_UI=privy AND PRIVY_APP_ID is set. Not a secret —
  // it rides in every Privy request the browser makes (lib/user-signed.ts:79).
  privyAppId?: string;
  nonce?: string;
}) {
  // SET HERE, NOT ONLY IN THE SHELL, and the difference is one real window. The
  // shell is a dynamic chunk, so between hydration and its arrival privyUiActive()
  // would answer false — and a Pay button pressed in that moment would take the
  // old server-signed path and come back with a message about an export password
  // that does not exist. This runs during hydration, from the same server-decided
  // value, so the answer is right from the first render. Idempotent.
  if (privyAppId) markPrivyUi();

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider>
          {privyAppId ? <PrivyShell appId={privyAppId} nonce={nonce} /> : null}
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
