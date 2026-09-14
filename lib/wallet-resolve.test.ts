import assert from "node:assert/strict";
import { test } from "node:test";
import {
  lookupParticipantAddress,
  resolveParticipantAddress,
  type ResolveDeps,
} from "./wallet-resolve.ts";

const ADDR_USER = "0x" + "11".repeat(20);
const ADDR_PENDING = "0x" + "22".repeat(20);
const ADDR_MINTED = "0x" + "33".repeat(20);

test("prefers an existing user's wallet", async () => {
  const deps: ResolveDeps = {
    getUserByProviderHandle: async () => ({ wallet_address: ADDR_USER }) as never,
    getPendingWallet: async () => {
      throw new Error("should not be called");
    },
    mintPending: async () => {
      throw new Error("should not be called");
    },
  };
  assert.equal(await resolveParticipantAddress("x", "alice", deps), ADDR_USER);
});

test("falls back to a pending wallet", async () => {
  const deps: ResolveDeps = {
    getUserByProviderHandle: async () => null,
    getPendingWallet: async () => ({ wallet_address: ADDR_PENDING }) as never,
    mintPending: async () => {
      throw new Error("should not be called");
    },
  };
  assert.equal(await resolveParticipantAddress("x", "alice", deps), ADDR_PENDING);
});

test("mints when neither exists", async () => {
  let minted = false;
  const deps: ResolveDeps = {
    getUserByProviderHandle: async () => null,
    getPendingWallet: async () => null,
    mintPending: async () => {
      minted = true;
      return ADDR_MINTED;
    },
  };
  assert.equal(await resolveParticipantAddress("x", "alice", deps), ADDR_MINTED);
  assert.equal(minted, true);
});

test("a user with no wallet_address yet falls through to pending/mint", async () => {
  const deps: ResolveDeps = {
    getUserByProviderHandle: async () => ({ wallet_address: null }) as never,
    getPendingWallet: async () => null,
    mintPending: async () => ADDR_MINTED,
  };
  assert.equal(await resolveParticipantAddress("x", "alice", deps), ADDR_MINTED);
});

test("lookup finds a real user's wallet", async () => {
  const address = await lookupParticipantAddress("email", "dani@example.com", {
    getUserByProviderHandle: async () => ({ wallet_address: "0xUSER" }),
    getPendingWallet: async () => null,
    mintPending: async () => { throw new Error("must not mint"); },
  });
  assert.equal(address, "0xUSER");
});

test("lookup falls back to a pending wallet", async () => {
  // Still not null: a handle that already has a pending wallet must resolve to
  // it, or the settle rail would escrow for someone it can already pay.
  const address = await lookupParticipantAddress("email", "dani@example.com", {
    getUserByProviderHandle: async () => null,
    getPendingWallet: async () => ({ wallet_address: ADDR_PENDING }),
    mintPending: async () => { throw new Error("must not mint"); },
  });
  assert.equal(address, ADDR_PENDING);
});

test("lookup answers null for someone who has never signed in", async () => {
  // The whole point: no wallet is minted, so no money can be sent to an address
  // its supposed owner cannot reach.
  const address = await lookupParticipantAddress("email", "nobody@example.com", {
    getUserByProviderHandle: async () => null,
    getPendingWallet: async () => null,
    mintPending: async () => { throw new Error("must not mint"); },
  });
  assert.equal(address, null);
});
