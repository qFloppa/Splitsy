import { walletProviderName } from "@/lib/wallet-provider";
import { getPrivyWallet } from "@/lib/privy-wallets-repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// WHICH STACK THIS DEPLOYMENT ACTUALLY RESOLVED — the one question no amount of
// reading the dashboard settles. docs/deployments.md describes the arrangement
// each host is MEANT to run under and says so out loud: "nothing in this repo
// asserts it is in place." This is that assertion, asked of the running process.
//
// It exists because both halves of a mis-scoped environment are silent. A Preview
// that inherits Production's Supabase variables reads the LIVE database, and the
// only symptom is a returning user being shown the Circle wallet their row
// already holds — lib/oauth-callback.ts:91 provisions only when wallet_address is
// null, so nothing errors and no Privy wallet is ever minted. Underneath that,
// privy_wallets exists only where Task 6 Step 1's schema ran, so on any other
// project getPrivyWallet throws into the best-effort catch at :103 and the login
// completes with no wallet at all. Neither shows up as a failure anywhere a person
// is looking.
//
// NAMES, NEVER VALUES. The project ref is already inlined into the client bundle
// through NEXT_PUBLIC_SUPABASE_URL, so echoing it discloses nothing new; every
// credential is reported as a bare boolean. And the whole route is gated on
// NEXT_PUBLIC_STACK_LABEL, which Production leaves unset (see "The banner"), so
// merging this to main leaves it inert on the live site rather than adding an
// endpoint that describes it.
export async function GET() {
  if (!process.env.NEXT_PUBLIC_STACK_LABEL) return new Response("Not found", { status: 404 });

  // The ref, not the URL: the URL is where the keys get pasted by mistake.
  const supabaseProject = process.env.NEXT_PUBLIC_SUPABASE_URL?.match(/([a-z0-9]+)\.supabase\.co/)?.[1] ?? null;

  // Reachability, not contents. A miss returns null and a missing TABLE throws
  // (lib/privy-wallets-repo.ts:25), which is exactly the fault this has to tell
  // apart — so the error is reported rather than swallowed.
  let privyWalletsTable: string;
  try {
    await getPrivyWallet("_stack_probe", "_stack_probe");
    privyWalletsTable = "reachable";
  } catch (caught) {
    privyWalletsTable = caught instanceof Error ? caught.message : "unreadable";
  }

  return Response.json({
    walletProvider: walletProviderName(),
    supabaseProject,
    privyWalletsTable,
    env: {
      WALLET_PROVIDER: process.env.WALLET_PROVIDER ?? null,
      SUPABASE_SERVICE_ROLE_KEY: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
      PRIVY_APP_ID: Boolean(process.env.PRIVY_APP_ID),
      PRIVY_APP_SECRET: Boolean(process.env.PRIVY_APP_SECRET),
      PRIVY_KEY_QUORUM_ID: Boolean(process.env.PRIVY_KEY_QUORUM_ID),
      PRIVY_AUTHORIZATION_PRIVATE_KEY: Boolean(process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY),
      PRIVY_AGENT_POLICY_ID: Boolean(process.env.PRIVY_AGENT_POLICY_ID),
      // Must be ABSENT here: docs/deployments.md:28-29. Reported so an inherited
      // one is visible rather than waiting to be discovered by a throw.
      CIRCLE_API_KEY: Boolean(process.env.CIRCLE_API_KEY),
      NEXT_PUBLIC_AUTOPAY_MANDATE_ADDRESS: Boolean(process.env.NEXT_PUBLIC_AUTOPAY_MANDATE_ADDRESS),
    },
    // Which build answered, so a stale deployment cannot pose as a fresh one.
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
    builtAt: process.env.VERCEL_DEPLOYMENT_ID ?? null,
  });
}
