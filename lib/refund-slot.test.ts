import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak256, toHex } from "viem";
import { HandleBoundElsewhereError, refundSlotToOwner } from "./refund-slot.ts";
import { encodeRefundSlot } from "./handle-slot.ts";

const REGISTRY = "0x" + "ab".repeat(20);
const HANDLE = keccak256(toHex("x:alice"));
const TO = "0x" + "11".repeat(20);
const OTHER = "0x" + "22".repeat(20);
const ZERO = "0x0000000000000000000000000000000000000000";
const SIG = "0x" + "cd".repeat(65);

test("an unbound handle is bound first, then refunded", async () => {
  // Two legs, in that order. Refunding before the binding exists reverts with
  // NotBoundYet, so the order is the contract's requirement, not a preference.
  let signedFor: { handleHash: string; wallet: string } | null = null;
  const relayed: string[] = [];

  const result = await refundSlotToOwner({
    registryAddress: REGISTRY,
    billId: 7n,
    handleHash: HANDLE,
    to: TO,
    deps: {
      readBinding: async () => ZERO,
      signBind: async (_addr, handleHash, wallet) => {
        signedFor = { handleHash, wallet };
        return SIG;
      },
      relay: async (addr, data) => {
        relayed.push(data);
        assert.equal(addr, REGISTRY, "both legs go to the registry");
        return { txHash: `0xTX${relayed.length}` };
      },
    },
  });

  assert.deepEqual(signedFor, { handleHash: HANDLE, wallet: TO });
  assert.equal(relayed.length, 2, "bind then refundSlot");
  assert.equal(relayed[1], encodeRefundSlot(7n, HANDLE), "second leg is the signature-free refund");
  assert.equal(result.bindTxHash, "0xTX1");
  assert.equal(result.txHash, "0xTX2");
});

test("an already-bound handle skips the binding entirely", async () => {
  // No second signature, and nothing for a leaked key to do: the destination is
  // already fixed in storage. This is the common path after a user's first refund.
  let signCalls = 0;
  const relayed: string[] = [];

  const result = await refundSlotToOwner({
    registryAddress: REGISTRY,
    billId: 7n,
    handleHash: HANDLE,
    to: TO,
    deps: {
      readBinding: async () => TO,
      signBind: async () => {
        signCalls += 1;
        return SIG;
      },
      relay: async (_addr, data) => {
        relayed.push(data);
        return { txHash: "0xTX" };
      },
    },
  });

  assert.equal(signCalls, 0, "nothing was signed");
  assert.equal(relayed.length, 1, "one leg only");
  assert.equal(relayed[0], encodeRefundSlot(7n, HANDLE));
  assert.equal(result.bindTxHash, null);
});

test("a handle bound to someone else fails before spending any gas", async () => {
  // Write-once has a cost and this is it. Caught on the READ, so the user gets a
  // sentence naming the bound wallet instead of an AlreadyBound revert they paid
  // for. The money is not lost — anyone can call refundSlot and it pays there.
  let relayCalls = 0;

  await assert.rejects(
    refundSlotToOwner({
      registryAddress: REGISTRY,
      billId: 1n,
      handleHash: HANDLE,
      to: TO,
      deps: {
        readBinding: async () => OTHER,
        signBind: async () => SIG,
        relay: async () => {
          relayCalls += 1;
          return { txHash: "0xTX" };
        },
      },
    }),
    (err: unknown) => err instanceof HandleBoundElsewhereError && err.boundTo === OTHER,
  );

  assert.equal(relayCalls, 0, "no transaction was sent");
});

test("the binding comparison ignores address case", async () => {
  // Chain reads come back checksummed and session wallets often do not. A
  // case-sensitive compare here would read "bound elsewhere" for the same
  // address and refuse a refund that is perfectly fine.
  let relayCalls = 0;

  await refundSlotToOwner({
    registryAddress: REGISTRY,
    billId: 1n,
    handleHash: HANDLE,
    to: TO.toUpperCase().replace("0X", "0x"),
    deps: {
      readBinding: async () => TO,
      signBind: async () => SIG,
      relay: async () => {
        relayCalls += 1;
        return { txHash: "0xTX" };
      },
    },
  });

  assert.equal(relayCalls, 1, "treated as already bound to this wallet");
});

test("the deadline it signs is in the future and inside the window", async () => {
  // A deadline in the past makes every binding revert with SignatureExpired; one
  // far in the future leaves a leaked signature useful for years.
  let deadline = 0n;
  const now = BigInt(Math.floor(Date.now() / 1000));

  await refundSlotToOwner({
    registryAddress: REGISTRY,
    billId: 1n,
    handleHash: HANDLE,
    to: TO,
    deps: {
      readBinding: async () => ZERO,
      signBind: async (_addr, _hash, _wallet, d) => {
        deadline = d;
        return SIG;
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
      handleHash: HANDLE,
      to: TO,
      deps: {
        readBinding: async () => TO,
        signBind: async () => SIG,
        relay: async () => {
          throw new Error("NothingToRefund");
        },
      },
    }),
    /NothingToRefund/,
  );
});
