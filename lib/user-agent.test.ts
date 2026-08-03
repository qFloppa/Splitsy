// getOrCreateUserAgent's cache branch is the one thing in this module that can
// be pinned without a network: a users row carrying BOTH agent columns is
// answered from the row, and anything less falls through to Circle. That "&&"
// is load-bearing — a half-written row (address saved, wallet id lost) would
// otherwise hand a caller a walletId of null and fail deep inside a signature.
//
// The fall-through cases are made offline by unsetting the Circle credentials,
// so they run the same way on a developer machine that has them and in CI that
// does not: getConfig() returns null, getOrCreateArcWallet returns null before
// it opens a socket, and the Supabase cache write is never reached either.
// Everything else here — the allowance, the identity mint — is genuinely
// network-bound and has no seam; those are not tested rather than mocked.
import test from "node:test";
import assert from "node:assert/strict";
import { agentToAdopt, getOrCreateUserAgent, wasAgentAdoptedFrom } from "./user-agent.ts";

const CIRCLE_VARS = ["CIRCLE_API_KEY", "CIRCLE_ENTITY_SECRET", "CIRCLE_WALLET_SET_ID"] as const;
const original = CIRCLE_VARS.map((k) => [k, process.env[k]] as const);

test.before(() => {
  for (const k of CIRCLE_VARS) delete process.env[k];
});

test.after(() => {
  for (const [k, v] of original) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("a fully cached row is answered from the row, without Circle", async () => {
  const agent = await getOrCreateUserAgent({
    id: "user-1",
    agent_wallet_address: "0xabc0000000000000000000000000000000000001",
    agent_wallet_id: "wallet-1",
  });
  assert.deepEqual(agent, { address: "0xabc0000000000000000000000000000000000001", walletId: "wallet-1" });
});

test("a half-written row falls through instead of returning a null walletId", async () => {
  const missingId = await getOrCreateUserAgent({
    id: "user-2",
    agent_wallet_address: "0xabc0000000000000000000000000000000000002",
    agent_wallet_id: null,
  });
  assert.equal(missingId, null, "address without wallet id must not be served from cache");

  const missingAddress = await getOrCreateUserAgent({
    id: "user-3",
    agent_wallet_address: null,
    agent_wallet_id: "wallet-3",
  });
  assert.equal(missingAddress, null, "wallet id without address must not be served from cache");
});

test("an empty row with Circle unconfigured is a null, not a throw", async () => {
  const agent = await getOrCreateUserAgent({ id: "user-4", agent_wallet_address: null, agent_wallet_id: null });
  assert.equal(agent, null);
});

// The merge decision, which is a MONEY decision in both directions: adopting
// strands whatever the session's own agent holds, and not adopting leaves the
// funded one unreachable from the account that just took the wallet over. Both
// directions are pinned because inverting this reads the same in the UI.
const DONOR = { address: "0xAAA0000000000000000000000000000000000001", walletId: "wallet-a" };

test("the merged-in account's agent wins when ours is empty or absent", () => {
  assert.deepEqual(agentToAdopt({ address: null, balance: 0n }, DONOR), {
    address: DONOR.address,
    walletId: "wallet-a",
  });
  assert.deepEqual(agentToAdopt({ address: "0xbbb0000000000000000000000000000000000002", balance: 0n }, DONOR), {
    address: DONOR.address,
    walletId: "wallet-a",
  });
});

test("a funded agent of our own is never overwritten", () => {
  // 1n is also what the route passes when the balance cannot be read, so this
  // pins the RPC-failure path too: unreadable loses the merge, never the money.
  assert.equal(agentToAdopt({ address: "0xbbb0000000000000000000000000000000000002", balance: 1n }, DONOR), null);
});

test("nothing to adopt is a null, not a half-written row", () => {
  assert.equal(agentToAdopt({ address: null, balance: 0n }, { address: null, walletId: null }), null);
  assert.equal(agentToAdopt({ address: null, balance: 0n }, { address: DONOR.address, walletId: null }), null);
  assert.equal(agentToAdopt({ address: null, balance: 0n }, { address: null, walletId: "wallet-a" }), null);
  // Already the same agent — the columns are equal, so the write would be a
  // no-op, and reporting an adoption would tell the user something happened.
  assert.equal(agentToAdopt({ address: DONOR.address.toLowerCase(), balance: 0n }, DONOR), null);
});

// The other half of the pair. Unlink hands the agent back only when link took
// it, so this predicate decides whether an account keeps the agent it is holding.
test("an agent shared with the donor account reads as adopted, whatever the case", () => {
  assert.equal(
    wasAgentAdoptedFrom(
      { id: "social", agentAddress: DONOR.address.toLowerCase() },
      { id: "wallet", agentAddress: DONOR.address },
    ),
    true,
  );
});

test("an agent of our own is never handed back", () => {
  // Different agents: this account minted its own, so there is nothing to return.
  assert.equal(
    wasAgentAdoptedFrom(
      { id: "social", agentAddress: "0xbbb0000000000000000000000000000000000002" },
      { id: "wallet", agentAddress: DONOR.address },
    ),
    false,
  );
  // The donor IS us — a wallet account unlinking its own sign-in address must
  // not clear the agent it has always owned.
  assert.equal(
    wasAgentAdoptedFrom({ id: "same", agentAddress: DONOR.address }, { id: "same", agentAddress: DONOR.address }),
    false,
  );
  // No donor account at all: an ordinary browser wallet that was only ever
  // linked, never signed in with.
  assert.equal(wasAgentAdoptedFrom({ id: "social", agentAddress: DONOR.address }, null), false);
  assert.equal(wasAgentAdoptedFrom({ id: "social", agentAddress: null }, { id: "wallet", agentAddress: null }), false);
});
