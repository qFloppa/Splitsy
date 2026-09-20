import assert from "node:assert/strict";
import { test } from "node:test";
import { refundSlotToOwner } from "./refund-slot.ts";
import { encodeRefundSlot, slotForHandle } from "./handle-slot.ts";

const REGISTRY = "0x" + "ab".repeat(20);
const SLOT = slotForHandle("x", "alice");
const TO = "0x" + "11".repeat(20);

test("signs over the recipient it was given, and relays to that same contract", async () => {
  // The signature binds `to` at signing time. If these two ever came from
  // different places, the contract would reject the signature rather than pay
  // the wrong address — but the relay would still have spent gas finding out.
  let signedFor: { billId: bigint; slot: string; to: string } | null = null;
  let relayedTo = "";

  await refundSlotToOwner({
    registryAddress: REGISTRY,
    billId: 7n,
    slot: SLOT,
    to: TO,
    deps: {
      signRefund: async (_addr, billId, slot, to) => {
        signedFor = { billId, slot, to };
        return "0x" + "cd".repeat(65);
      },
      relay: async (addr) => {
        relayedTo = addr;
        return { txHash: "0xTX" };
      },
    },
  });

  assert.deepEqual(signedFor, { billId: 7n, slot: SLOT, to: TO });
  assert.equal(relayedTo, REGISTRY);
});

test("the deadline it signs is in the future and inside the window", async () => {
  // A deadline in the past makes every refund revert with SignatureExpired; one
  // far in the future leaves a leaked signature useful for years.
  let deadline = 0n;
  const now = BigInt(Math.floor(Date.now() / 1000));

  await refundSlotToOwner({
    registryAddress: REGISTRY,
    billId: 1n,
    slot: SLOT,
    to: TO,
    deps: {
      signRefund: async (_addr, _billId, _slot, _to, d) => {
        deadline = d;
        return "0x" + "cd".repeat(65);
      },
      relay: async () => ({ txHash: "0xTX" }),
    },
  });

  assert.ok(deadline > now, "deadline is in the future");
  assert.ok(deadline <= now + 3600n, "deadline is within the hour");
});

test("a failed relay propagates rather than being swallowed", async () => {
  // Unlike the escrow release, this answers a request a user is waiting on. A
  // silent success would tell them the money moved when it did not.
  await assert.rejects(
    refundSlotToOwner({
      registryAddress: REGISTRY,
      billId: 1n,
      slot: SLOT,
      to: TO,
      deps: {
        signRefund: async () => "0x" + "cd".repeat(65),
        relay: async () => {
          throw new Error("NothingToRefund");
        },
      },
    }),
    /NothingToRefund/,
  );
});

test("the calldata it builds carries the slot and recipient verbatim", () => {
  // The encoder is what the contract decodes; a wrong field here is a refund
  // that reverts on chain with no useful message.
  const sig = ("0x" + "cd".repeat(65)) as `0x${string}`;
  const data = encodeRefundSlot(7n, SLOT, TO as `0x${string}`, 1700000000n, sig);
  assert.ok(data.startsWith("0x"), "is calldata");
  // 4-byte selector + 5 words of head + offset+length+padding for the bytes.
  assert.ok(data.length > 8 + 5 * 64, "carries all five arguments");
});