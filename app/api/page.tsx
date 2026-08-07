import type { Metadata } from "next";
import { DevelopersPage } from "@/components/landing/DevelopersPage";

export const metadata: Metadata = {
  title: "Developer API",
  description:
    "Seven x402-paywalled HTTP APIs for the Splitsy agent economy. Any agent, no Splitsy account, no API key, no gas.",
  openGraph: {
    title: "Splitsy Developer API — build on the agent economy",
    description:
      "Seven x402-paywalled HTTP APIs. Pay per call in USDC over Circle Gateway. No account required.",
  },
};

export default function Page() {
  return <DevelopersPage />;
}
