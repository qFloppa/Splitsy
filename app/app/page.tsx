import type { Metadata } from "next";
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

  return <HomeClient testCycleEnabled={testCycleEnabled} />;
}
