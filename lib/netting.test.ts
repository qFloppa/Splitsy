import assert from "node:assert/strict";
import test from "node:test";
import { computeMinimumTransfers, formatUsdcFromMicros, previewSettlement } from "./netting.ts";
import type { Charge, Member } from "./types.ts";

const members: Member[] = [
  member("alice", "Alice"),
  member("bob", "Bob"),
  member("carla", "Carla"),
  member("dev", "Dev"),
];

test("nets reciprocal debts into one residual payment", () => {
  const charges: Charge[] = [
    charge("c1", "alice", "12.00", ["bob"]),
    charge("c2", "bob", "9.00", ["alice"]),
  ];

  const preview = previewSettlement(members.slice(0, 2), charges);

  assert.equal(preview.naiveTransactionCount, 2);
  assert.equal(preview.nettedTransactionCount, 1);
  assert.deepEqual(preview.transfers.map(readableTransfer), ["bob->alice:3.00"]);
});

test("reduces a multi-person period to the minimum greedy transfer list", () => {
  const charges: Charge[] = [
    charge("c1", "alice", "120.00", ["alice", "bob", "carla", "dev"]),
    charge("c2", "bob", "30.00", ["alice", "carla", "dev"]),
  ];

  const preview = previewSettlement(members, charges);

  assert.equal(preview.naiveTransactionCount, 6);
  assert.equal(preview.nettedTransactionCount, 2);
  assert.deepEqual(preview.transfers.map(readableTransfer), [
    "carla->alice:40.00",
    "dev->alice:40.00",
  ]);
});

test("handles fractional USDC splits without dropping micros", () => {
  const charges: Charge[] = [charge("c1", "alice", "10.00", ["alice", "bob", "carla"])];
  const preview = previewSettlement(members.slice(0, 3), charges);
  const total = preview.positions.reduce((sum, position) => sum + position.amountMicros, 0n);

  assert.equal(total, 0n);
  assert.deepEqual(preview.transfers.map(readableTransfer), [
    "bob->alice:3.33",
    "carla->alice:3.33",
  ]);
});

test("ignores zero positions in the transfer algorithm", () => {
  const transfers = computeMinimumTransfers([
    { memberId: "alice", amountMicros: 0n },
    { memberId: "bob", amountMicros: -1_000_000n },
    { memberId: "carla", amountMicros: 1_000_000n },
  ]);

  assert.deepEqual(transfers.map(readableTransfer), ["bob->carla:1.00"]);
});

function member(id: string, displayName: string): Member {
  return {
    id,
    tab_id: "tab-demo",
    display_name: displayName,
    evm_address: `0x${id.padEnd(40, "0")}`,
    arc_recipient_address: `0x${id.padEnd(40, "1")}`,
    created_at: "2026-06-19T00:00:00.000Z",
  };
}

function charge(
  id: string,
  paidBy: string,
  amount: string,
  splitAmong: string[],
): Charge {
  return {
    id,
    tab_id: "tab-demo",
    paid_by_member_id: paidBy,
    amount_usdc: amount,
    description: id,
    split_among: splitAmong,
    created_at: "2026-06-19T00:00:00.000Z",
  };
}

function readableTransfer(transfer: { fromMemberId: string; toMemberId: string; amountMicros: bigint }) {
  return `${transfer.fromMemberId}->${transfer.toMemberId}:${formatUsdcFromMicros(
    transfer.amountMicros,
  )}`;
}
