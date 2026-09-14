import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseEscrowForHandle } from "./escrow-release.ts";

test("does nothing when the wallet has not arrived yet", async () => {
  // The Privy login route calls this twice: once the instant authentication
  // flips true, when createOnLogin has not built the wallet yet, and again once
  // it has. Signing a release to a null address on the first pass would burn the
  // deposit id and the second pass would find nothing.
  let signed = 0;
  await releaseEscrowForHandle("user-1", "email", "dani@example.com", null, {
    getOpenDeposits: async () => [{ escrow_address: "0xESC", deposit_id: "1", amount_usdc: "1.000000" }],
    signRelease: async () => { signed++; return "0xSIG"; },
    relay: async () => ({ txHash: "0xTX" }),
    markReleased: async () => {},
  });
  assert.equal(signed, 0);
});

test("releases every open deposit for the handle", async () => {
  const released: string[] = [];
  await releaseEscrowForHandle("user-1", "email", "dani@example.com", "0xWALLET", {
    getOpenDeposits: async () => [
      { escrow_address: "0xESC", deposit_id: "1", amount_usdc: "1.000000" },
      { escrow_address: "0xESC", deposit_id: "2", amount_usdc: "2.000000" },
    ],
    signRelease: async () => "0xSIG",
    relay: async () => ({ txHash: "0xTX" }),
    markReleased: async (_addr, id) => { released.push(id); },
  });
  assert.deepEqual(released, ["1", "2"]);
});

test("one failed release does not stop the next", async () => {
  // A deposit already released by an earlier attempt reverts with NoSuchDeposit.
  // That must not strand the others — the row stays open and the next sign-in
  // retries it.
  const released: string[] = [];
  await releaseEscrowForHandle("user-1", "email", "dani@example.com", "0xWALLET", {
    getOpenDeposits: async () => [
      { escrow_address: "0xESC", deposit_id: "1", amount_usdc: "1.000000" },
      { escrow_address: "0xESC", deposit_id: "2", amount_usdc: "2.000000" },
    ],
    signRelease: async () => "0xSIG",
    relay: async (_addr, id) => {
      if (id === "1") throw new Error("NoSuchDeposit");
      return { txHash: "0xTX" };
    },
    markReleased: async (_addr, id) => { released.push(id); },
  });
  assert.deepEqual(released, ["2"]);
});
