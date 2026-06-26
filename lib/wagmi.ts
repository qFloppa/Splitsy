"use client";

import { http } from "wagmi";
import {
  arbitrumSepolia,
  arcTestnet,
  avalancheFuji,
  baseSepolia,
  optimismSepolia,
  polygonAmoy,
  sepolia,
} from "viem/chains";
import { getDefaultConfig } from "@rainbow-me/rainbowkit";

// Arc Testnet stays first so it remains the default/initial chain, but every
// chain the app can bridge from must be registered too — otherwise RainbowKit
// flags the wallet as "Wrong network" when a user is connected to, say, Base
// Sepolia before bridging. Keep this list in sync with `bridgeSourceChains` in
// `lib/appkit-bridge.ts`.
export const wagmiConfig = getDefaultConfig({
  appName: "Splitsy",
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "",
  chains: [arcTestnet, baseSepolia, sepolia, arbitrumSepolia, optimismSepolia, avalancheFuji, polygonAmoy],
  transports: {
    [arcTestnet.id]: http(process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL ?? "https://rpc.testnet.arc.network"),
    [baseSepolia.id]: http(),
    [sepolia.id]: http(),
    [arbitrumSepolia.id]: http(),
    [optimismSepolia.id]: http(),
    [avalancheFuji.id]: http(),
    [polygonAmoy.id]: http(),
  },
  ssr: true,
});
