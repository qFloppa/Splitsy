"use client";

import { http } from "wagmi";
import { getWalletClient, switchChain } from "wagmi/actions";
import {
  arbitrum,
  arbitrumSepolia,
  avalanche,
  avalancheFuji,
  base,
  baseSepolia,
  mainnet,
  optimism,
  optimismSepolia,
  polygon,
  polygonAmoy,
  sepolia,
} from "viem/chains";
import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import type { Chain } from "viem";
import { ARC, forArcNetwork } from "./arc-chain.ts";

// Arc stays first so it remains the default/initial chain, but every
// chain the app can bridge from must be registered too — otherwise RainbowKit
// flags the wallet as "Wrong network" when a user is connected to, say, Base
// Sepolia before bridging. Keep this list in sync with `bridgeSourceChains` in
// `lib/appkit-bridge.ts`: same six chains, picked by the same switch, so a
// mainnet build registers the mainnet six and never a Sepolia.
// The type argument is spelled out because forArcNetwork infers from its first
// argument, and viem types each chain as its own literal.
const sourceChains = forArcNetwork<Chain[]>(
  [base, mainnet, arbitrum, optimism, avalanche, polygon],
  [baseSepolia, sepolia, arbitrumSepolia, optimismSepolia, avalancheFuji, polygonAmoy],
);

export const wagmiConfig = getDefaultConfig({
  appName: "Splitsy",
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "",
  chains: [ARC.chain, ...sourceChains],
  transports: Object.fromEntries([
    [ARC.chainId, http(ARC.rpcUrl)],
    ...sourceChains.map((chain) => [chain.id, http()]),
  ]),
  ssr: true,
});

// Every write this app makes lands on Arc, so every signer it asks for has to be
// on Arc — and `getWalletClient({ chainId })` does NOT put it there. It ASSERTS:
// if the connector is sitting on Sepolia it throws "The current chain of the
// connector (id: 11155111) does not match the connection's chain (id: 5042002)"
// and the caller reports that to the user as if it were the reason their payment
// failed. The switch has to come first, at every call site, without exception —
// which is why it lives here instead: four of the six sites remembered it by
// hand and two didn't, and one of those two was "Pay on Arc" on a public /pay
// link, i.e. the one button in the product a stranger presses first.
//
// Unconditional on purpose. `wallet_switchEthereumChain` for the chain you are
// already on is a no-op that resolves, so a guard would only buy a `getChainId`
// round-trip and a second way to be wrong.
export async function arcWalletClient() {
  await switchChain(wagmiConfig, { chainId: ARC.chainId });
  return getWalletClient(wagmiConfig, { chainId: ARC.chainId });
}
