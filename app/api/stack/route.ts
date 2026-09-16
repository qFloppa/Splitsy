import { walletProviderName } from "@/lib/wallet-provider";
import { getPrivyWallet } from "@/lib/privy-wallets-repo";
import { createSupabaseServerClient } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The newest wallet, checked against the properties that can ONLY be set at
// creation. owner_id is the THIRD of these — after PRIVY_AGENT_POLICY_ID
// (docs/deployments.md:125-138) — and the pattern is always the same: nothing
// detects the omission, no backfill repairs it, so a wallet minted wrong is wrong
// forever and only a re-mint fixes it. Documentation did not catch the second one.
//
// Reports booleans and ids, never keys, matching the rest of this route. Never
// throws: a probe that can take the route down is worse than one that says it
// could not look.
async function walletCreationProperties() {
  const client = createSupabaseServerClient();
  if (!client) return { checked: false, reason: "supabase not configured" };

  const { data, error } = await client
    .from("privy_wallets")
    .select("namespace, wallet_id")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return { checked: false, reason: error?.message ?? "no wallets yet" };

  try {
    const { PrivyClient } = await import("@privy-io/node");
    const privy = new PrivyClient({
      appId: process.env.PRIVY_APP_ID ?? "",
      appSecret: process.env.PRIVY_APP_SECRET ?? "",
    });
    const wallet = await privy.wallets().get(data.wallet_id);
    // Trimmed, matching quorumId() (lib/privy-wallet.ts) and resolveState
    // (app/api/wallet/export/route.ts). A padded value would make this probe
    // report a correctly-minted wallet as owned by someone else.
    const quorum = process.env.PRIVY_KEY_QUORUM_ID?.trim();
    return {
      checked: true,
      walletId: data.wallet_id,
      namespace: data.namespace,
      // Owned by SOMEONE. A wallet whose ownership the user has taken for export
      // is correct, not broken, so this asserts only that an owner was set at all —
      // which is the thing creation can silently stop doing.
      ownerSet: wallet.owner_id !== null,
      // And owned by US, which is what a freshly minted wallet must look like
      // before anyone enables export on it.
      ownedByQuorum: wallet.owner_id === quorum,
      // Without this the server cannot sign at all once ownership moves. The
      // `?? []` is type-dead — the SDK types the field as always present — and
      // KEPT anyway: this is a diagnostic whose whole job is to answer "what is
      // actually true in this deployment", and it must report a malformed
      // response as `false` rather than throw its own probe into the catch below.
      quorumIsAdditionalSigner: (wallet.additional_signers ?? []).some((s) => s.signer_id === quorum),
      // Only the agent namespace carries the enclave cap; null means "not applicable".
      agentPolicyExpected: data.namespace === "agent" ? Boolean(process.env.PRIVY_AGENT_POLICY_ID) : null,
    };
  } catch (caught) {
    return { checked: false, reason: caught instanceof Error ? caught.message : "privy unreachable" };
  }
}

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
// endpoint that describes it. That gate is the ONLY thing keeping this off the
// live site — the directory name is not a second layer of protection.
//
// It lived at app/api/_stack/ until this commit, where it answered nothing at
// all: Next excludes underscore-prefixed folders from routing entirely (docs
// 01-app/04-glossary.md:149), so the route was absent from routes-manifest.json
// and every request fell through to the not-found page. An endpoint whose whole
// job is to assert that a deployment is what it claims spent its life
// unreachable, silently, which is the exact failure mode described above.
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
    walletCreation: await walletCreationProperties(),
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
