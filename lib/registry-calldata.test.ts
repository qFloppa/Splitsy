import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFunctionData } from "viem";
import {
  encodeApprove,
  encodeClaim,
  encodeCreateBill,
  encodeExecuteBatch,
  encodePayDebt,
  REGISTRY_CALL_ABI,
  ERC20_APPROVE_ABI,
  SCA_BATCH_ABI,
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

test("encodeExecuteBatch round-trips every leg in order", () => {
  const approve = encodeApprove("0x1111111111111111111111111111111111111111", 3_000000n);
  const pay = encodePayDebt(7n, 1_000000n);
  const batch = encodeExecuteBatch([
    { to: "0x2222222222222222222222222222222222222222", data: approve },
    { to: "0x3333333333333333333333333333333333333333", data: pay },
  ]);

  const decoded = decodeFunctionData({ abi: SCA_BATCH_ABI, data: batch });
  assert.equal(decoded.functionName, "executeBatch");
  const calls = decoded.args[0] as readonly { target: string; value: bigint; data: string }[];
  assert.equal(calls.length, 2);
  assert.equal(calls[0].target.toLowerCase(), "0x2222222222222222222222222222222222222222");
  assert.equal(calls[0].value, 0n);
  assert.equal(calls[0].data, approve);
  assert.equal(calls[1].data, pay); // order preserved: approve must precede the pays
});

test("encodeExecuteBatch refuses an empty batch", () => {
  assert.throws(() => encodeExecuteBatch([]), /no calls/);
});
