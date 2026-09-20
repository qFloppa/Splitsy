import assert from "node:assert/strict";
import { test } from "node:test";
import { lookupParticipantAddress, resolveParticipantAddress, type ResolveDeps } from "./wallet-resolve.ts";
import { slotForHandle } from "./handle-slot.ts";

const ADDR_USER = "0x" + "11".repeat(20);
const ADDR_PENDING = "0x" + "22".repeat(20);
const ADDR_SLOT = slotForHandle("x", "alice");

test("prefers an existing user's wallet", async () => {
  const deps: ResolveDeps = {
    getUserByProviderHandle: async () => ({ wallet_address: ADDR_USER }) as never,
    getPendingWallet: async () => {
      throw new Error("should not be called");
    },
  };
  assert.equal(await resolveParticipantAddress("x", "alice", deps), ADDR_USER);
});

test("falls back to a pending wallet", async () => {
  const deps: ResolveDeps = {
    getUserByProviderHandle: async () => null,
    getPendingWallet: async () => ({ wallet_address: ADDR_PENDING }) as never,
  };
  assert.equal(await resolveParticipantAddress("x", "alice", deps), ADDR_PENDING);
});

test("derives a slot when neither exists", async () => {
  // No wallet is minted. The address is a pure function of the handle, which is
  // what makes the tagged stranger non-custodial: no key exists to hold.
  const deps: ResolveDeps = {
    getUserByProviderHandle: async () => null,
    getPendingWallet: async () => null,
  };
  assert.equal(await resolveParticipantAddress("x", "alice", deps), ADDR_SLOT);
});

test("a user with no wallet_address yet falls through to a slot", async () => {
  const deps: ResolveDeps = {
    getUserByProviderHandle: async () => ({ wallet_address: null }) as never,
    getPendingWallet: async () => null,
  };
  assert.equal(await resolveParticipantAddress("x", "alice", deps), ADDR_SLOT);
});

test("the same handle derives the same slot across calls", async () => {
  // Idempotence is the property bills depend on: two tags of @alice must be one
  // address, or the second bill files a debt against nobody.
  const deps: ResolveDeps = {
    getUserByProviderHandle: async () => null,
    getPendingWallet: async () => null,
  };
  const first = await resolveParticipantAddress("x", "alice", deps);
  const second = await resolveParticipantAddress("x", "alice", deps);
  assert.equal(first, second);
});

test("lookup finds a real user's wallet", async () => {
  const address = await lookupParticipantAddress("email", "dani@example.com", {
    getUserByProviderHandle: async () => ({ wallet_address: "0xUSER" }),
    getPendingWallet: async () => null,
  });
  assert.equal(address, "0xUSER");
});

test("lookup falls back to a pending wallet on the Circle stack", async () => {
  // Still not null THERE: finishProviderLogin adopts the pending row at login, so
  // the address really becomes that person's — and answering null would escrow for
  // someone Splitsy can already pay.
  delete process.env.WALLET_UI;
  const address = await lookupParticipantAddress("email", "dani@example.com", {
    getUserByProviderHandle: async () => null,
    getPendingWallet: async () => ({ wallet_address: ADDR_PENDING }),
  });
  assert.equal(address, ADDR_PENDING);
});

test("lookup IGNORES a slot on the Privy stack", async () => {
  // A slot is DERIVED, so nobody holds a key to it — money sent there is money
  // nobody can ever move. HandleEscrow holds the same money with a release at
  // login plus a reclaim for the sender, so the rail that moves money must not be
  // handed a slot; the row is not even read.
  process.env.WALLET_UI = "privy";
  try {
    const address = await lookupParticipantAddress("email", "dani@example.com", {
      getUserByProviderHandle: async () => null,
      getPendingWallet: async () => {
        throw new Error("must not read a pre-mint on this stack");
      },
    });
    assert.equal(address, null);
  } finally {
    delete process.env.WALLET_UI;
  }
});

test("a real user's wallet still wins on the Privy stack", async () => {
  // The gate is only about pre-mints — someone who has actually signed in has a
  // reachable wallet and must keep going on chain.
  process.env.WALLET_UI = "privy";
  try {
    const address = await lookupParticipantAddress("email", "dani@example.com", {
      getUserByProviderHandle: async () => ({ wallet_address: ADDR_USER }),
      getPendingWallet: async () => {
        throw new Error("should not be called");
      },
    });
    assert.equal(address, ADDR_USER);
  } finally {
    delete process.env.WALLET_UI;
  }
});

test("lookup answers null for someone who has never signed in", async () => {
  // The whole point: no wallet is minted, so no money can be sent to an address
  // its supposed owner cannot reach.
  const address = await lookupParticipantAddress("email", "nobody@example.com", {
    getUserByProviderHandle: async () => null,
    getPendingWallet: async () => null,
  });
  assert.equal(address, null);
});