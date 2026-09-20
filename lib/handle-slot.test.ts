import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak256, toFunctionSelector, toHex } from "viem";
import { encodeRefundSlot, refundSlotDomain, REFUND_SLOT_TYPES, slotForHandle } from "./handle-slot.ts";

test("golden vector: x:alice matches Solidity", () => {
  // Must match BillSplitRegistry.t.sol's testSlotDerivationMatchesTypeScript.
  // If these ever disagree, refunds fail in prod with "NotParticipant".
  assert.equal(slotForHandle("x", "alice"), "0xc9834a77ddbba5cd5de18f51981da02b790aeded");
});

test("golden vector: normalization is applied before hashing", () => {
  // "@Alice" and "alice" are the same person, so they must be the same slot —
  // this is the half the Solidity vector cannot cover, since the contract never
  // sees a raw handle.
  assert.equal(slotForHandle("x", "@Alice"), slotForHandle("x", "alice"));
  assert.equal(slotForHandle("X", "alice"), slotForHandle("x", "alice"));
});

test("derived slot is deterministic", () => {
  const a = slotForHandle("discord", "bob");
  const b = slotForHandle("discord", "bob");
  assert.equal(a, b);
});

test("different handles produce different slots", () => {
  const a = slotForHandle("x", "alice");
  const b = slotForHandle("x", "bob");
  assert.notEqual(a, b);
});

test("different providers produce different slots", () => {
  const a = slotForHandle("x", "alice");
  const b = slotForHandle("discord", "alice");
  assert.notEqual(a, b);
});

// The signing half. The slot vector above decides WHERE a debt is filed; these
// decide whether the signature authorizing its refund verifies at all. Each is
// pinned against the same value BillSplitRegistry.t.sol checks, so a drift on
// either side fails in a test rather than as an InvalidSignature on a real
// refund — which is the failure mode this whole pinning exists to avoid.

test("golden vector: the EIP-712 typehash matches the contract's", () => {
  // Field names and order are part of the hash. Renaming `slot` or moving
  // `deadline` changes this value and silently invalidates every signature.
  const typehash = keccak256(
    toHex("RefundSlot(uint256 billId,address slot,address to,uint256 deadline)"),
  );
  assert.equal(typehash, "0x0839007c5ec3423006f0b25f02dc659006a7a827b441364dca638ef68b0c64de");

  // And that the shape we actually sign is the one that hashes to it.
  const encoded = REFUND_SLOT_TYPES.RefundSlot.map((f) => `${f.type} ${f.name}`).join(",");
  assert.equal(keccak256(toHex(`RefundSlot(${encoded})`)), typehash);
});

test("the domain is BillSplit's own, not HandleEscrow's", () => {
  // Sharing a separator would let a release signature verify as a refund.
  const domain = refundSlotDomain(1, `0x${"ab".repeat(20)}`);
  assert.equal(domain.name, "Splitsy BillSplit");
  assert.notEqual(domain.name, "Splitsy HandleEscrow");
  assert.equal(domain.version, "1");
});

test("the encoder targets the contract's refundSlot selector", () => {
  // A wrong selector reverts with no reason string — the least debuggable
  // failure this path has.
  const data = encodeRefundSlot(
    7n,
    slotForHandle("x", "alice"),
    `0x${"11".repeat(20)}`,
    1700000000n,
    `0x${"cd".repeat(65)}`,
  );
  assert.equal(
    data.slice(0, 10),
    toFunctionSelector("refundSlot(uint256,address,address,uint256,bytes)"),
  );
});
