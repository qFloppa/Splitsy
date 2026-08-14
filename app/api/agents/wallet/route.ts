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
import { getProvenWalletAccount, getSessionUser } from "@/lib/session";
import type { AppUser } from "@/lib/types";
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
      ...NO_OTHER_ACCOUNT,
      jobs: [],
    });
  }

  const [balance, identity, rules, log, walletAccount] = await Promise.all([
    getAgentBalanceUsdc(agent.address).catch(() => 0n),
    getAgentByWallet(agent.address).catch(() => null),
    getAutopayGrant(user.id).catch(() => null),
    listAutopayLog(user.id).catch(() => []),
    // The connected browser wallet's OWN account, if it has one. Never fails the
    // card: absent reads as "there is only one agent", the answer in almost
    // every case.
    walletAccountAgent(user, new URL(request.url).searchParams.get("connected") ?? "").catch(
      () => NO_OTHER_ACCOUNT,
    ),
  ]);

  // Register the identity in the background once the agent has gas to pay for
  // it. Deferred with after() rather than a bare `void`, which is not optional
  // here: a dangling promise is frozen the moment the response is sent on
  // serverless, so the mint could be killed between the register tx and the row
  // that records its tokenId — stranding the NFT and letting the next page load
  // mint another. after() keeps the function alive until it finishes. A failure
  // still leaves the agent perfectly able to settle; it just has no NFT yet.
  if (!identity?.agent_id && balance > 0n) {
    after(() => ensureUserAgentIdentity(agent));
  }

  return Response.json({
    address: agent.address,
    tokenId: identity?.agent_id ?? process.env.NEXT_PUBLIC_USER_AGENT_TOKEN_ID ?? null,
    balanceUsdc: Number(balance) / 1e6,
    moneyMode: rules?.moneyMode ?? "mandate",
    ...walletAccount,
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

const NO_OTHER_ACCOUNT = { otherAgent: null, agentFromWallet: null };

// What the connected browser wallet's OWN account contributes to this card.
//
// A wallet sign-in mints a whole account (see /api/auth/wallet), so someone who
// used this tab before adding a social login has two accounts and two agents,
// each with its own refId, its own balance and its own copy of the rules. Two
// facts come out of that, and the card needs both:
//
//   * otherAgent — a SECOND agent, still separate. Showing only the session's is
//     how USDC ends up in an agent the person cannot find: they funded it under
//     one login and then looked for it under the other. `enabled` comes with it
//     because an agent that can spend while its rules are invisible from here is
//     the whole reason this panel exists.
//   * agentFromWallet — the two are ALREADY merged, and this account holds the
//     agent only because linking adopted it. Unlinking gives it back, so the
//     warning has to stop promising the balance is untouched.
//
// Resolved from the signed PROOF this browser holds rather than from the address
// in the query, so learning that an address has a Splitsy account — and what its
// agent holds, and whether it is armed — takes that wallet's own signature. The
// query string only narrows it to the wallet the extension is on now.
async function walletAccountAgent(user: AppUser, connected: string) {
  const address = connected.toLowerCase();
  const own = await getProvenWalletAccount(user.id, address);
  if (!own || !own.agent_wallet_address) return NO_OTHER_ACCOUNT;

  // Both rows naming one agent wallet is the merged state. Rendering it as a
  // second agent would invent a balance that does not exist.
  if (own.agent_wallet_address.toLowerCase() === (user.agent_wallet_address ?? "").toLowerCase()) {
    return { otherAgent: null, agentFromWallet: address };
  }

  const [balance, rules] = await Promise.all([
    getAgentBalanceUsdc(own.agent_wallet_address as `0x${string}`).catch(() => 0n),
    getAutopayGrant(own.id).catch(() => null),
  ]);
  return {
    otherAgent: {
      address: own.agent_wallet_address,
      balanceUsdc: Number(balance) / 1e6,
      // Funded mode is the only one this UI writes, and there `enabled` is the
      // whole answer — no mandate on chain to disagree with it.
      enabled: rules?.enabled === true && rules.moneyMode === "funded",
    },
    agentFromWallet: null,
  };
}
