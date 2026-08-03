// The user's own agent, read for the "Your agent" card.
//
// Session-scoped: this is one person's wallet, balance and job history. The
// agent is created on first read, which is deliberate — someone has to look at
// the card before they can fund it, and the wallet must exist to be funded.
// Creating a DCW costs nothing until it is used.
import { after } from "next/server";
import { getAutopayGrant, listAutopayLog } from "@/lib/agents-repo";
// The authoritative wallet -> ERC-8004 agent id mapping. It survives a registry
// redeploy, which is why identity is resolved from here and not from an env var.
import { getAgentByWallet } from "@/lib/reputation-repo";
import { getSessionUser } from "@/lib/session";
import { getAgentBalanceUsdc, ensureUserAgentIdentity, getOrCreateUserAgent } from "@/lib/user-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });

  const agent = await getOrCreateUserAgent(user);
  if (!agent) {
    // Circle is not configured. Say so as an absent agent rather than an error:
    // the panel renders "no agent yet", which is the truth.
    return Response.json({ address: null, tokenId: null, balanceUsdc: 0, moneyMode: "mandate", jobs: [] });
  }

  const [balance, identity, rules, log] = await Promise.all([
    getAgentBalanceUsdc(agent.address).catch(() => 0n),
    getAgentByWallet(agent.address).catch(() => null),
    getAutopayGrant(user.id).catch(() => null),
    listAutopayLog(user.id).catch(() => []),
  ]);

  // Register the identity in the background once the agent has gas to pay for
  // it. Deferred with after() rather than a bare `void`, which is not optional
  // here: a dangling promise is frozen the moment the response is sent on
  // serverless, so the mint could be killed between the register tx and the row
  // that records its tokenId — stranding the NFT and letting the next page load
  // mint another. after() keeps the function alive until it finishes. A failure
  // still leaves the agent perfectly able to settle; it just has no NFT yet.
  if (!identity?.agent_id && balance > 0n) {
    after(() => ensureUserAgentIdentity(agent, user.wallet_address));
  }

  return Response.json({
    address: agent.address,
    tokenId: identity?.agent_id ?? process.env.NEXT_PUBLIC_USER_AGENT_TOKEN_ID ?? null,
    balanceUsdc: Number(balance) / 1e6,
    moneyMode: rules?.moneyMode ?? "mandate",
    // Only the rows that opened a job. A skip has no job and belongs in the
    // decision log, which the panel already renders separately.
    jobs: log
      .filter((row) => row.jobId)
      .map((row) => ({
        billId: row.billId,
        jobId: row.jobId,
        jobStatus: row.jobStatus,
        feeUsdc: row.feeUsdc,
        txHash: row.txHash,
        createdAt: row.createdAt,
      })),
  });
}
