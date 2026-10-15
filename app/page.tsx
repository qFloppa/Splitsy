import type { Metadata } from "next";
import LandingPage from "@/components/landing/LandingPage";
import { ARC_LABEL, forArcNetwork } from "@/lib/arc-chain";

export const metadata: Metadata = {
  title: `Splitsy · split any receipt with anyone, settled on ${ARC_LABEL}`,
  description: forArcNetwork(
    "Scan a receipt, tag friends by X, Discord, email, or wallet address, and settle the split in USDC on Arc. One click, real USDC, nothing to install.",
    "Scan a receipt, tag friends by X, Discord, email, or wallet address, and settle the split in USDC on Arc Testnet. One click. No real funds, just a testnet demo.",
  ),
  alternates: { canonical: "/" },
};

export default function Home() {
  return <LandingPage />;
}
