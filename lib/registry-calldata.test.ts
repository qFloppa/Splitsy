import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFunctionData } from "viem";
import {
  encodeApprove,
  encodeClaim,
  encodeCreateBill,
  encodePayDebt,
  REGISTRY_CALL_ABI,
  ERC20_APPROVE_ABI,
} from "./registry-calldata.ts";

test("encodeCreateBill round-trips through decodeFunctionData", () => {
  const data = encodeCreateBill(
    ("0x" + "ab".repeat(32)) as `0x${string}`,
    [("0x" + "11".repeat(20)) as `0x${string}`],
    [1000000n],
  );
  const decoded = decodeFunctionData({ abi: REGISTRY_CALL_ABI, data });
  assert.equal(decoded.functionName, "createBill");
  assert.equal(decoded.args[2][0], 1000000n);
});

test("encodePayDebt and encodeClaim encode billId + amount", () => {
  const pay = decodeFunctionData({ abi: REGISTRY_CALL_ABI, data: encodePayDebt(5n, 250n) });
  assert.equal(pay.functionName, "payDebt");
  assert.deepEqual(pay.args, [5n, 250n]);
  const claim = decodeFunctionData({ abi: REGISTRY_CALL_ABI, data: encodeClaim(5n, 250n) });
  assert.equal(claim.functionName, "claim");
  assert.deepEqual(claim.args, [5n, 250n]);
});

test("encodeApprove encodes spender + amount", () => {
  const spender = ("0x" + "22".repeat(20)) as `0x${string}`;
  const decoded = decodeFunctionData({ abi: ERC20_APPROVE_ABI, data: encodeApprove(spender, 999n) });
  assert.equal(decoded.functionName, "approve");
  assert.equal(decoded.args[1], 999n);
});
