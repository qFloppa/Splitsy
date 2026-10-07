import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak256, toFunctionSelector, toHex } from "viem";
import { BIND_TYPES, bindDomain, encodeBind, encodeRefundSlot, slotForHandle } from "./handle-slot.ts";

test("golden vector: x:alice matches Solidity", () => {
  // Must match BillSplitRegistry.t.sol's testSlotDerivationMatchesTypeScript.
  // If these ever disagree, refunds fail in prod with "NotParticipant".
  assert.equal(slotForHandle("x", "alice"), "0x50cf558fd8f494fbd881bad3c9834a77ddbba5cd");
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
  // Field names and order are part of the hash. Renaming `wallet` or moving
  // `deadline` changes this value and silently invalidates every signature.
  const typehash = keccak256(
    toHex("Bind(bytes32 handleHash,address wallet,uint256 deadline)"),
  );
  assert.equal(typehash, "0x1adc3991894b22b3c051e8195f6b53ee11b99beb7e7165b10a2928c2261eadf5");

  // And that the shape we actually sign is the one that hashes to it.
  const encoded = BIND_TYPES.Bind.map((f: { type: string; name: string }) => `${f.type} ${f.name}`).join(",");
  assert.equal(keccak256(toHex(`Bind(${encoded})`)), typehash);
});

test("the domain is BillSplit's own, not HandleEscrow's", () => {
  // Sharing a separator would let a release signature verify as a binding.
  const domain = bindDomain(1, `0x${"ab".repeat(20)}`);
  assert.equal(domain.name, "Splitsy BillSplit");
  assert.notEqual(domain.name, "Splitsy HandleEscrow");
  assert.equal(domain.version, "1");
});

test("the bind encoder targets the contract's bind selector", () => {
  // A wrong selector reverts with no reason string — the least debuggable
  // failure this path has.
  const data = encodeBind(
    keccak256(toHex("x:alice")),
    `0x${"11".repeat(20)}`,
    1700000000n,
    `0x${"cd".repeat(65)}`,
  );
  assert.equal(data.slice(0, 10), toFunctionSelector("bind(bytes32,address,uint256,bytes)"));
});

test("refundSlot takes no destination and no signature", () => {
  // THE SECURITY PROPERTY, AS A SELECTOR. If this ever grows an address
  // argument again, a signature could aim a refund somewhere and write-once
  // binding would have been pointless.
  const data = encodeRefundSlot(7n, keccak256(toHex("x:alice")));
  assert.equal(data.slice(0, 10), toFunctionSelector("refundSlot(uint256,bytes32)"));
  // Selector plus exactly two words: nothing else fits.
  assert.equal(data.length, 10 + 2 * 64);
});

test("the slot the contract derives is the one TypeScript files", () => {
  // refundSlot derives `address(bytes20(handleHash))` internally, so these two
  // formulas must agree or a refund hits NotParticipant. Leading 20 bytes on
  // both sides — a slice from the wrong end is the failure this catches.
  const hash = keccak256(toHex("x:alice"));
  assert.equal(slotForHandle("x", "alice"), hash.slice(0, 42));
});
