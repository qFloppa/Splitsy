// The binding check on the user-signed relay path. This is the one piece of new
// validation on app/api/wallet/send, and its absence would be silent: the route
// would relay whatever bytes it was handed, report success, and any ledger row
// written off that report would describe a payment nobody asked for.
//
// Pure function, no Privy, no chain — hence testable without either. It lives in
// lib/privy-wallet.ts beside the calldata it re-encodes rather than in the route,
// because a route importing next/headers cannot be imported by a test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeFunctionData, erc20Abi, getAddress, parseUnits } from "viem";
import { relayGuard } from "./privy-wallet.ts";
import { ARC_TESTNET_USDC } from "./x402/constants.ts";

const TO = "0x09BCd0d3C7A0c0f7E5C0a1DdcCe8B3D6e0eB6df1";
const AMOUNT = 12.5;

// What a correct relay looks like, built the way the route builds it.
const transactionFor = (to: string, amount: number) => ({
  to: ARC_TESTNET_USDC,
  data: encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [getAddress(to), parseUnits(amount.toFixed(6), 6)],
  }),
  nonce: "0x0",
  chain_id: 5042002,
  type: 2,
  gas_limit: "0x5208",
  max_fee_per_gas: "0x3b9aca00",
  max_priority_fee_per_gas: "0x3b9aca00",
});

const SIGNATURE = "MEUCIQDdErq1nHvGM5oQ7PqS2fKq4w==";

test("a transfer matching to and amount is relayed", () => {
  const result = relayGuard(TO, AMOUNT, transactionFor(TO, AMOUNT), SIGNATURE);
  assert.ok(!("error" in result), `unexpected rejection: ${"error" in result ? result.error : ""}`);
  assert.equal(result.signature, SIGNATURE);
  assert.deepEqual(result.transaction, transactionFor(TO, AMOUNT));
});

// THE POINT OF THE GUARD. A signature is valid over whatever it was made for, so
// this is the only thing stopping the route relaying a transfer to somewhere else
// while reporting the {to, amount} it was asked about.
test("a transfer to a different recipient is refused", () => {
  const elsewhere = "0x1111111111111111111111111111111111111111";
  const result = relayGuard(TO, AMOUNT, transactionFor(elsewhere, AMOUNT), SIGNATURE);
  assert.ok("error" in result);
});

test("a transfer of a different amount is refused", () => {
  const result = relayGuard(TO, AMOUNT, transactionFor(TO, 12.500001), SIGNATURE);
  assert.ok("error" in result);
});

// Not a USDC transfer at all — an approve, or a call into some other contract.
test("a call to another contract is refused", () => {
  const tx = { ...transactionFor(TO, AMOUNT), to: "0x2222222222222222222222222222222222222222" };
  const result = relayGuard(TO, AMOUNT, tx, SIGNATURE);
  assert.ok("error" in result);
});

// The amount is compared through parseUnits, so a caller cannot slip a rounded
// value past it: 12.5 and 12.5000001 encode differently and only one is accepted.
test("the amount comparison is exact, not rounded", () => {
  assert.ok(!("error" in relayGuard(TO, 12.5, transactionFor(TO, 12.5), SIGNATURE)));
  assert.ok("error" in relayGuard(TO, 12.5, transactionFor(TO, 12.6), SIGNATURE));
});

test("a missing or empty signature is refused", () => {
  assert.ok("error" in relayGuard(TO, AMOUNT, transactionFor(TO, AMOUNT), ""));
  assert.ok("error" in relayGuard(TO, AMOUNT, transactionFor(TO, AMOUNT), undefined));
  assert.ok("error" in relayGuard(TO, AMOUNT, transactionFor(TO, AMOUNT), 42));
});

test("a missing or non-object transaction is refused", () => {
  assert.ok("error" in relayGuard(TO, AMOUNT, undefined, SIGNATURE));
  assert.ok("error" in relayGuard(TO, AMOUNT, null, SIGNATURE));
  assert.ok("error" in relayGuard(TO, AMOUNT, "0xdeadbeef", SIGNATURE));
});

// The calldata is re-encoded from {to, amount}, so the selector must be the real
// ERC-20 transfer one. A wrong ABI here would make every legitimate relay fail —
// loudly, but only in production, and this is cheaper.
test("the expected calldata carries the ERC-20 transfer selector", () => {
  const { data } = transactionFor(TO, AMOUNT) as { data: string };
  assert.ok(data.startsWith("0xa9059cbb"), `expected the transfer selector, got ${data.slice(0, 10)}`);
});
