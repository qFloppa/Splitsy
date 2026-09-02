// The user's own agent: a Circle DCW they fund, holding an ERC-8004 identity of
// its own.
//
// ONE PER ACCOUNT, not per wallet. The refId is 'agent:<userId>', so a person
// who signs in socially AND links a browser wallet has one agent, one balance
// and one identity covering both. They fund it once. This needs no new lookup:
// the autopay route already resolves either kind of address down to a userId.
//
// The agent needs USDC for two things in BOTH money modes — its own gas (Arc
// charges gas in USDC) and the job fee it escrows — which is why funding is now
// required even in Mandate mode, where nothing used to be. In Funded mode it
// also pays the bill share, and then its BALANCE is the cap: an agent holding
// 5 USDC can never spend 6. That is a simpler and more honest ceiling than a
// mandate, and it needs no contract.
import { getUsdcAllowanceOnchain, getUsdcBalanceOnchain } from "./arc-read.ts";
import { ensureAgent } from "./erc8004.ts";
import { encodeApprove } from "./registry-calldata.ts";
import { setUserAgentWallet } from "./users-repo.ts";
import { executeContract, getOrCreateWallet } from "./wallet-provider.ts";

export type UserAgent = { address: `0x${string}`; walletId: string };

const ARC_USDC_ADDRESS = (process.env.ARC_TESTNET_USDC_ADDRESS ??
  "0x3600000000000000000000000000000000000000") as `0x${string}`;

// Get-or-create, with the users row as a cache in front of Circle. Circle stays
// authoritative — listWallets by refId is idempotent — but a page load should
// not pay a round trip to learn an address that has not changed.
export async function getOrCreateUserAgent(user: {
  id: string;
  agent_wallet_address: string | null;
  agent_wallet_id: string | null;
}): Promise<UserAgent | null> {
  if (user.agent_wallet_address && user.agent_wallet_id) {
    return { address: user.agent_wallet_address as `0x${string}`, walletId: user.agent_wallet_id };
  }

  // 'agent' is a provider namespace of its own, so it can never collide with a
  // signin wallet ("<provider>:<id>"), a pre-mint wallet ("prem:…") or the
  // Splitsy service wallets ("splitsy:…").
  const wallet = await getOrCreateWallet("agent", user.id);
  if (!wallet) return null;

  // Cache it, but never let a cache write fail the caller: the wallet exists on
  // Circle either way, and the next call re-derives it.
  await setUserAgentWallet(user.id, wallet.address, wallet.walletId).catch((err) => {
    console.error(`user-agent: could not cache the agent wallet for ${user.id}:`, err);
  });

  return { address: wallet.address as `0x${string}`, walletId: wallet.walletId };
}

export async function getAgentBalanceUsdc(address: `0x${string}`): Promise<bigint> {
  return getUsdcBalanceOnchain(address);
}

// Which agent survives when a browser wallet that already had a Splitsy account
// of its own is linked into another one.
//
// Two logins mean two accounts: /api/auth/wallet mints one from a signature, so
// anyone who used the Agents tab before adding a social login has two, each with
// its own agent under its own refId. Linking is what collapses them, and the
// DONOR's agent — the LINKED WALLET's own — always survives. The wallet is the
// thing being linked, so its agent is the one the user is pointing at; which of
// the two happens to hold USDC does not change which one they named.
//
// A funded session agent is not lost to this, which is why the balance no longer
// gets a say. Adoption only overwrites two columns, and unlink is its exact
// inverse (see wasAgentAdoptedFrom): clearing them re-derives this account's own
// agent from its unchanged refId, balance and all.
export function agentToAdopt(
  mineAddress: string | null,
  donor: { address: string | null; walletId: string | null },
): { address: string; walletId: string } | null {
  if (!donor.address || !donor.walletId) return null;
  if (mineAddress?.toLowerCase() === donor.address.toLowerCase()) return null;
  return { address: donor.address, walletId: donor.walletId };
}

// The inverse, asked at unlink time: does this account hold its agent ONLY
// because linking adopted it from that wallet's own account? If so, unlinking
// hands it back, which is what makes unlink the true inverse of link rather than
// a half-undo that leaves the donor locked out of the agent it funded.
//
// No column remembers the adoption because none is needed: the donor row still
// names the agent it donated, so an address match IS the record. Clearing on a
// false POSITIVE is self-healing rather than destructive — an account that was
// never merged re-derives the very same wallet from its unchanged refId — while a
// false NEGATIVE strands the donor. Hence a match on the agent address itself and
// nothing looser.
export function wasAgentAdoptedFrom(
  mine: { id: string; agentAddress: string | null },
  donor: { id: string; agentAddress: string | null } | null,
): boolean {
  if (!donor || !mine.agentAddress || !donor.agentAddress) return false;
  if (donor.id === mine.id) return false;
  return donor.agentAddress.toLowerCase() === mine.agentAddress.toLowerCase();
}

// A week of fees and shares at the amount being spent right now, so the next
// hundred settlements do not each pay for their own approval.
// ponytail: 100x the amount in hand is a guess at "a week" — meter real settlement volume and set it from that, or approve the exact amount every time if a standing allowance ever needs justifying
const APPROVAL_MULTIPLE = 100n;

// Lazy, self-healing USDC approval.
//
// Sent immediately before the call that needs it, and only when the current
// allowance is short. NOT on top-up: a top-up is an inbound transfer the agent
// cannot hook. NOT at wallet creation: approve costs gas, and a wallet with no
// balance cannot pay it. Checking the ALLOWANCE rather than a database flag is
// what makes it self-healing — if the approval is ever spent down, or the row
// is lost, the next settlement re-sends it.
//
// Two spenders need this, for two different reasons:
//   * AgenticCommerce — fund() pulls the job fee into escrow.
//   * BillSplitRegistry — payDebtFor does safeTransferFrom(msg.sender, …) in
//     Funded mode. The spec's §4 named only the first; this is the second.
//
// A RETURN FROM THIS FUNCTION MEANS THE ALLOWANCE IS ON CHAIN. Nothing weaker
// is safe to hand a caller: the next thing they do is fund() or payDebtFor,
// which pulls against it, and a pull against an allowance that never mined
// fails after the job has already been created and priced. So every outcome
// that is not a terminal success throws — including the quiet one, where the
// Circle backend's poll times out and RETURNS "PENDING" rather than raising
// (lib/circle-dcw.ts:167; the Privy backend throws instead, tagged or not
// depending on whether the transaction can still mine). Both Task 7 call sites
// already sit inside a try that turns a throw into a skipped settlement, which is
// the outcome we want.
export async function ensureAgentAllowance(
  agent: UserAgent,
  spender: `0x${string}`,
  need: bigint,
  pollMs?: number,
): Promise<void> {
  const allowance = await getUsdcAllowanceOnchain(agent.address, spender);
  if (allowance >= need) return;
  const tx = await executeContract(
    agent.walletId,
    ARC_USDC_ADDRESS,
    encodeApprove(spender, need * APPROVAL_MULTIPLE),
    pollMs,
  );
  if (tx.state !== "COMPLETE" && tx.state !== "CONFIRMED") {
    throw new Error(`agent USDC approval for ${spender} is ${tx.state} — allowance unconfirmed (tx ${tx.id})`);
  }
}

// The agent's ERC-8004 identity, minted once and KEPT BY THE AGENT.
//
// Keyed on the AGENT's address, not the user's: the user's main wallet already
// carries their own 'splitsy-payer' identity from paying bills, and reusing it
// would mean the agent has no identity of its own at all.
//
// It is not handed on to the user's wallet, and that is the point. This NFT is
// the agent's identity — the thing that signs jobs and accrues the agent's own
// feedback — so the agent must hold it, exactly as an ERC-8004 identity is
// meant to sit in the account it names. The REPUTATION NFT is the one that
// belongs to the person: erc8004.ts mints that from the registrar and transfers
// it on to the payer. Two different NFTs, two different owners; this used to
// copy the reputation handover and left the agent identity-less.
export async function ensureUserAgentIdentity(agent: UserAgent): Promise<string | null> {
  try {
    return await ensureAgent(agent.address, agent.walletId, undefined, "splitsy-user-agent");
  } catch (err) {
    console.error("user-agent: identity registration failed (settlement continues):", err);
    return null;
  }
}
