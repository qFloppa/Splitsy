import type { Metadata } from "next";

import { getEscrowBounds } from "@/lib/arc-read";
import { describeDailyCeiling, describeHoldWindow } from "@/lib/security-facts";
import { siteContracts } from "@/lib/site-contracts";
import { SecurityPage } from "@/components/landing/SecurityPage";

// The server half: everything the page says about THIS deployment is gathered
// here and handed down, so components/landing/SecurityPage.tsx holds prose and
// nothing a reader could check against the chain.
//
// Both figures are read live for the reason lib/site-contracts.ts gives about
// the addresses beside them: a trust page that quietly drifts from the
// deployment is worse than one that prints no number. The escrow's two bounds
// are immutable constructor arguments WITH env-var overrides in
// scripts/deploy-handle-escrow.ts, so quoting that script's defaults would be
// quoting what Splitsy meant to deploy rather than what is there.

// Render at request time so the nonce-based CSP (see proxy.ts) is applied to
// this page's framework scripts — the same reason /docs and /legal force it.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Safety",
  description:
    "How Splitsy's contracts protect your money, in plain English: no owner, no pause, no way to empty them, how money held for someone with no wallet works, and what could still go wrong.",
  openGraph: {
    title: "Splitsy Safety — nobody can move your money, not even us",
    description:
      "No owner, no admin, no pause button, no withdraw-all. What the contracts guarantee, how escrow works for someone who hasn't joined yet, and an honest list of what could still go wrong.",
  },
};

export default async function Page() {
  const { holdWindowSeconds, maxReleasePerDayUnits } = await getEscrowBounds();

  return (
    <SecurityPage
      contracts={siteContracts()}
      dailyCeiling={describeDailyCeiling(maxReleasePerDayUnits)}
      holdWindow={describeHoldWindow(holdWindowSeconds)}
    />
  );
}
