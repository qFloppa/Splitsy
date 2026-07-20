import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import { getSettledMembersFromLogs, MEMBER_SETTLED_ABI } from "./recurring-read.ts";

const TAB = ("0x" + "ab".repeat(20)) as `0x${string}`;
const OTHER = ("0x" + "cd".repeat(20)) as `0x${string}`;
const memberAddr = (n: number) => ("0x" + n.toString(16).padStart(2, "0").repeat(20)) as `0x${string}`;

type Log = { address: string; data: `0x${string}`; topics: [] | [`0x${string}`, ...`0x${string}`[]] };

function memberSettledLog(address: string, member: `0x${string}`, amount: bigint, success: boolean): Log {
  const topics = encodeEventTopics({
    abi: MEMBER_SETTLED_ABI,
    eventName: "MemberSettled",
    args: { tabId: 1n, member },
  });
  const data = encodeAbiParameters([{ type: "uint256" }, { type: "bool" }], [amount, success]);
  return { address, data, topics: topics as Log["topics"] };
}

function shortfallLog(address: string, member: `0x${string}`): Log {
  const topics = encodeEventTopics({
    abi: MEMBER_SETTLED_ABI,
    eventName: "SettlementShortfall",
    args: { tabId: 1n, member },
  });
  return { address, data: "0x", topics: topics as Log["topics"] };
}

test("scores a member who paid their full cycle due", () => {
  const m = memberAddr(0x11);
  const paid = getSettledMembersFromLogs([memberSettledLog(TAB, m, 1_000_000n, true)], TAB);
  assert.equal(paid.length, 1);
  assert.equal(paid[0].member, m.toLowerCase());
  assert.equal(paid[0].amount, 1_000_000n);
});

test("skips a partial payer (MemberSettled>0 + SettlementShortfall)", () => {
  const m = memberAddr(0x22);
  const paid = getSettledMembersFromLogs(
    [memberSettledLog(TAB, m, 400_000n, true), shortfallLog(TAB, m)],
    TAB,
  );
  assert.equal(paid.length, 0);
});

test("skips a member who could pay nothing (amount 0 + shortfall)", () => {
  const m = memberAddr(0x33);
  const paid = getSettledMembersFromLogs(
    [memberSettledLog(TAB, m, 0n, false), shortfallLog(TAB, m)],
    TAB,
  );
  assert.equal(paid.length, 0);
});

test("ignores logs from a contract that isn't the settled tab", () => {
  const m = memberAddr(0x44);
  const paid = getSettledMembersFromLogs([memberSettledLog(OTHER, m, 1_000_000n, true)], TAB);
  assert.equal(paid.length, 0);
});

test("scores full payers while skipping partial ones in the same settlement", () => {
  const full = memberAddr(0x55);
  const partial = memberAddr(0x66);
  const paid = getSettledMembersFromLogs(
    [
      memberSettledLog(TAB, full, 1_000_000n, true),
      memberSettledLog(TAB, partial, 250_000n, true),
      shortfallLog(TAB, partial),
    ],
    TAB,
  );
  assert.equal(paid.length, 1);
  assert.equal(paid[0].member, full.toLowerCase());
});

test("scores a catch-up settlement covering multiple cycles as one full payment", () => {
  // When the settler misses cycles, the tab pulls several cycles' due at once
  // and emits a single MemberSettled with the combined amount and no shortfall.
  const m = memberAddr(0x77);
  const paid = getSettledMembersFromLogs([memberSettledLog(TAB, m, 3_000_000n, true)], TAB);
  assert.equal(paid.length, 1);
  assert.equal(paid[0].amount, 3_000_000n);
});
