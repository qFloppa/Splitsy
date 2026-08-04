import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPayRows } from "./build-rows.ts";

const P = (owed: bigint, paid: bigint) => ({ owed, paid, exists: true });

test("labels and providers pair with participants by position", () => {
  const rows = buildPayRows({
    participantList: ["0xAaA", "0xBbB", "0xCcC"],
    participants: [P(1000000n, 0n), P(2000000n, 0n), P(3000000n, 0n)],
    labels: ["@mert", "@sarah", "Payer 3"],
    providers: ["x", "discord", "wallet"],
    liveHandles: new Map(),
  });
  assert.deepEqual(rows.map((r) => r.label), ["@mert", "@sarah", "Payer 3"]);
  assert.deepEqual(rows.map((r) => r.provider), ["x", "discord", "wallet"]);
  assert.deepEqual(rows.map((r) => r.remainingUnits), ["1000000", "2000000", "3000000"]);
});

test("a live handle beats the creation-time label snapshot", () => {
  const rows = buildPayRows({
    participantList: ["0xAaA", "0xBbB"],
    participants: [P(1000000n, 0n), P(1000000n, 0n)],
    labels: ["@old_handle", "@sarah"],
    providers: ["x", "x"],
    liveHandles: new Map([["0xaaa", { handle: "new_handle", provider: "discord" }]]),
  });
  assert.equal(rows[0].label, "@new_handle");
  assert.equal(rows[0].provider, "discord");
  assert.equal(rows[1].label, "@sarah");
});

test("a short label array (pre-migration row) falls back without shifting", () => {
  const rows = buildPayRows({
    participantList: ["0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa", "0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb"],
    participants: [P(1000000n, 0n), P(2000000n, 0n)],
    labels: ["@mert"],
    providers: [],
    liveHandles: new Map(),
  });
  assert.equal(rows[0].label, "@mert");
  assert.equal(rows[1].label, "0xBbBb…BbBb");
  assert.equal(rows[1].provider, null);
  assert.equal(rows[1].remainingUnits, "2000000");
});

test("a settled participant reports zero remaining, not a negative", () => {
  const rows = buildPayRows({
    participantList: ["0xAaA", "0xBbB"],
    participants: [P(5000000n, 5000000n), P(5000000n, 7000000n)],
    labels: ["@a", "@b"],
    providers: ["x", "x"],
    liveHandles: new Map(),
  });
  assert.equal(rows[0].remainingUnits, "0");
  assert.equal(rows[1].remainingUnits, "0");
});

test("partial payment reports only what is left", () => {
  const rows = buildPayRows({
    participantList: ["0xAaA"],
    participants: [P(3000000n, 1200000n)],
    labels: ["@a"],
    providers: ["x"],
    liveHandles: new Map(),
  });
  assert.equal(rows[0].owedUnits, "3000000");
  assert.equal(rows[0].paidUnits, "1200000");
  assert.equal(rows[0].remainingUnits, "1800000");
});

test("an unreadable participant slot is omitted, not shown as a $0 phantom", () => {
  const rows = buildPayRows({
    participantList: ["0xAaA", "0xBbB", "0xCcC"],
    participants: [P(1000000n, 0n), null, { owed: 0n, paid: 0n, exists: false }],
    labels: ["@a", "@b", "@c"],
    providers: ["x", "x", "x"],
    liveHandles: new Map(),
  });
  assert.deepEqual(rows.map((r) => r.label), ["@a"]);
});

// The omission above drops the tail, so nothing survives *after* a hole. A
// builder walking labels with a running counter instead of index k would still
// pass it — and would land "@a" on the wrong person's debt here.
test("a row after an omitted slot keeps its own label, not the omitted one's", () => {
  const rows = buildPayRows({
    participantList: ["0xAaA", "0xBbB"],
    participants: [null, P(2000000n, 0n)],
    labels: ["@a", "@b"],
    providers: ["x", "discord"],
    liveHandles: new Map(),
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, "@b");
  assert.equal(rows[0].provider, "discord");
  assert.equal(rows[0].address, "0xBbB");
});

test("live handle lookup is case-insensitive against checksummed chain addresses", () => {
  const rows = buildPayRows({
    participantList: ["0xAbCdEf1234567890AbCdEf1234567890AbCdEf12"],
    participants: [P(1000000n, 0n)],
    labels: ["Payer 1"],
    providers: ["wallet"],
    liveHandles: new Map([["0xabcdef1234567890abcdef1234567890abcdef12", { handle: "lina", provider: "x" }]]),
  });
  assert.equal(rows[0].label, "@lina");
});
