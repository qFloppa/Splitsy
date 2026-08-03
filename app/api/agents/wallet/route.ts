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
import type { AppUser } from "@/lib/types";
import { getUserByProviderHandle } from "@/lib/users-repo";
import { getAgentBalanceUsdc, ensureUserAgentIdentity, getOrCreateUserAgent } from "@/lib/user-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });

  const agent = await getOrCreateUserAgent(user);
  if (!agent) {
    // Circle is not configured. Say so as an absent agent rather than an error:
    // the panel renders "no agent yet", which is the truth.
    return Response.json({
      address: null,
      tokenId: null,
      balanceUsdc: 0,
      moneyMode: "mandate",
      otherAgent: null,
      jobs: [],
    });
  }

  const [balance, identity, rules, log, otherAgent] = await Promise.all([
    getAgentBalanceUsdc(agent.address).catch(() => 0n),
    getAgentByWallet(agent.address).catch(() => null),
    getAutopayGrant(user.id).catch(() => null),
    listAutopayLog(user.id).catch(() => []),
    // The connected browser wallet's OWN agent, if that wallet is an account of
    // its own. Never fails the card: an absent second agent reads as "there is
    // only one", which is the answer in almost every case.
    connectedAccountAgent(user, new URL(request.url).searchParams.get("connected") ?? "").catch(() => null),
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
    otherAgent,
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

// The SECOND agent, when there is one: the one belonging to the connected browser
// wallet's own account.
//
// A wallet sign-in mints a whole account (see /api/auth/wallet), so someone who
// used this tab before adding a social login has two accounts and two agents,
// each with its own refId and its own balance. The card only ever showed the
// session's, which is how USDC ends up in an agent the person can no longer find:
// they funded it under one login and then looked for it under the other. It is
// shown alongside until 'Link wallet' merges the two.
//
// ponytail: any signed-in user can ask this about any address and learn whether
// it has a Splitsy wallet account and what its agent's address is — both public
// chain addresses either way. Gate it behind a signature if that reads as a leak.
async function connectedAccountAgent(user: AppUser, connected: string) {
  const address = connected.toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(address)) return null;

  const own = await getUserByProviderHandle("wallet", address);
  if (!own || own.id === user.id || !own.agent_wallet_address) return null;
  // Already merged: after an adoption both rows name the same agent wallet, and
  // showing it twice would invent a second balance that does not exist.
  if (own.agent_wallet_address.toLowerCase() === (user.agent_wallet_address ?? "").toLowerCase()) return null;

  const balance = await getAgentBalanceUsdc(own.agent_wallet_address as `0x${string}`).catch(() => 0n);
  return { address: own.agent_wallet_address, balanceUsdc: Number(balance) / 1e6 };
}
