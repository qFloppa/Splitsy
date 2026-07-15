import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveParticipantAddress, type ResolveDeps } from "./wallet-resolve.ts";

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
