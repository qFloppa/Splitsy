"use client";

import { http } from "wagmi";
import { arcTestnet } from "viem/chains";
import { getDefaultConfig } from "@rainbow-me/rainbowkit";

export const wagmiConfig = getDefaultConfig({
  appName: "Splitsy",
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "",
  chains: [arcTestnet],
  transports: {
    [arcTestnet.id]: http(process.env.NEXT_PUBLIC_ARC_TESTNET_RPC_URL ?? "https://rpc.testnet.arc.network"),
  },
  ssr: true,
});
