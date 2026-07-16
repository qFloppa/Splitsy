import type { Metadata } from "next";
import LandingPage from "@/components/landing/LandingPage";

export const metadata: Metadata = {
  title: "Splitsy · split any receipt with anyone, settled on Arc",
  description:
    "Scan a receipt, tag friends by X, Discord, email, or wallet address, and settle the split in USDC on Arc Testnet. One click. No real funds, just a testnet demo.",
  alternates: { canonical: "/" },
};

export default function Home() {
  return <LandingPage />;
}
