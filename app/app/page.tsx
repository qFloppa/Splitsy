import type { Metadata } from "next";
import { walletSession } from "@/lib/wallet-session";
import HomeClient from "../HomeClient";

export const metadata: Metadata = {
  title: "App",
  alternates: { canonical: "/app" },
};

type HomePageProps = {
  searchParams: Promise<{ recurringTestCycle?: string | string[] }>;
};

export default async function Home({ searchParams }: HomePageProps) {
  const params = await searchParams;
  const querySecret = Array.isArray(params.recurringTestCycle)
    ? params.recurringTestCycle[0]
    : params.recurringTestCycle;
  const expectedSecret = process.env.RECURRING_TEST_CYCLE_SECRET;
  const testCycleEnabled = Boolean(expectedSecret && querySecret === expectedSecret);

  // Read here so the header's two account controls can be painted with the page
  // rather than three seconds after it. See lib/wallet-session.ts.
  return <HomeClient testCycleEnabled={testCycleEnabled} walletSession={await walletSession()} />;
}
