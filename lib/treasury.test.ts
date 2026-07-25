import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTreasury, type TreasuryInput } from "./treasury.ts";

const USDC = 1_000_000n;

function input(over: Partial<TreasuryInput> = {}): TreasuryInput {
  return { myWallets: ["0xme"], created: [], owed: [], identities: {}, ...over };
}

test("nets both directions with one counterparty into a single position", () => {
  const plan = buildTreasury(
    input({
      created: [
        {
          billId: "1",
          totalPaid: 0n,
          claimed: 0n,
          participants: [{ addr: "0xALICE", owed: 12n * USDC, paid: 0n }],
        },
      ],
      owed: [{ billId: "2", splitter: "0xalice", myOwed: 9n * USDC, myPaid: 0n }],
    }),
  );

  assert.equal(plan.positions.length, 1);
  const alice = plan.positions[0];
  assert.equal(alice.counterparty, "0xalice"); // addresses normalised to lowercase
  assert.equal(alice.theyOweMeUsdc, "12");
  assert.equal(alice.iOweThemUsdc, "9");
  assert.equal(alice.netUsdc, "3");
  assert.deepEqual(alice.payBillIds, ["2"]);
  assert.equal(plan.totalTheyOweMeUsdc, "12");
  assert.equal(plan.totalIOweThemUsdc, "9");
  assert.equal(plan.netUsdc, "3");
});

test("my own wallets are never counterparties to myself", () => {
  const plan = buildTreasury(
    input({
      myWallets: ["0xme", "0xMyOther"],
      created: [
        {
          billId: "1",
          totalPaid: 0n,
          claimed: 0n,
          participants: [
            { addr: "0xme", owed: 5n * USDC, paid: 0n },
            { addr: "0xmyother", owed: 5n * USDC, paid: 0n },
            { addr: "0xbob", owed: 5n * USDC, paid: 0n },
          ],
        },
      ],
      // Same bill seen from the participant side: I owe my own bill. Not a debt.
      owed: [{ billId: "1", splitter: "0xme", myOwed: 5n * USDC, myPaid: 0n }],
    }),
  );

  assert.deepEqual(
    plan.positions.map((p) => p.counterparty),
    ["0xbob"],
  );
  assert.equal(plan.totalIOweThemUsdc, "0");
  assert.deepEqual(plan.positions[0].payBillIds, []);
});

test("fully paid legs drop out entirely", () => {
  const plan = buildTreasury(
    input({
      created: [
        {
          billId: "1",
          totalPaid: 5n * USDC,
          claimed: 5n * USDC,
          participants: [{ addr: "0xbob", owed: 5n * USDC, paid: 5n * USDC }],
        },
      ],
      owed: [{ billId: "2", splitter: "0xcarla", myOwed: 4n * USDC, myPaid: 4n * USDC }],
    }),
  );

  assert.deepEqual(plan.positions, []);
  assert.deepEqual(plan.claimBillIds, []);
  assert.equal(plan.claimableUsdc, "0");
});

test("collects unclaimed funds on bills I created", () => {
  const plan = buildTreasury(
    input({
      created: [
        {
          billId: "7",
          totalPaid: 7n * USDC,
          claimed: 2n * USDC,
          participants: [{ addr: "0xbob", owed: 10n * USDC, paid: 7n * USDC }],
        },
      ],
    }),
  );

  assert.deepEqual(plan.claimBillIds, ["7"]);
  assert.equal(plan.claimableUsdc, "5");
  assert.equal(plan.positions[0].theyOweMeUsdc, "3"); // 10 owed - 7 paid
});

test("counts the legs a settle must execute", () => {
  const plan = buildTreasury(
    input({
      created: [
        {
          billId: "9",
          totalPaid: 4n * USDC,
          claimed: 0n,
          participants: [{ addr: "0xz", owed: 4n * USDC, paid: 4n * USDC }],
        },
      ],
      owed: [
        { billId: "1", splitter: "0xa", myOwed: 1n * USDC, myPaid: 0n },
        { billId: "2", splitter: "0xa", myOwed: 2n * USDC, myPaid: 0n },
        { billId: "3", splitter: "0xb", myOwed: 3n * USDC, myPaid: 0n },
      ],
    }),
  );

  assert.equal(plan.payLegCount, 3);
  assert.equal(plan.claimLegCount, 1);
  // Bill-by-bill: 3 debts x (approve + payDebt) + 1 claim.
  assert.equal(plan.grossTxCount, 7);
});

test("positions sort by absolute net, largest exposure first", () => {
  const plan = buildTreasury(
    input({
      created: [
        {
          billId: "1",
          totalPaid: 0n,
          claimed: 0n,
          participants: [{ addr: "0xalice", owed: 3n * USDC, paid: 0n }],
        },
      ],
      owed: [{ billId: "2", splitter: "0xbob", myOwed: 10n * USDC, myPaid: 0n }],
    }),
  );

  assert.deepEqual(
    plan.positions.map((p) => `${p.counterparty}:${p.netUsdc}`),
    ["0xbob:-10", "0xalice:3"],
  );
});

test("labels and identity buckets come from the identity map, else the address", () => {
  const plan = buildTreasury(
    input({
      created: [
        {
          billId: "1",
          totalPaid: 0n,
          claimed: 0n,
          participants: [
            { addr: "0xalice", owed: 2n * USDC, paid: 0n },
            { addr: "0xstranger", owed: 1n * USDC, paid: 0n },
          ],
        },
      ],
      identities: { "0xalice": { label: "@alice", provider: "x" } },
    }),
  );

  const byAddr = new Map(plan.positions.map((p) => [p.counterparty, p]));
  assert.equal(byAddr.get("0xalice")!.label, "@alice");
  assert.equal(byAddr.get("0xalice")!.bucket, "x");
  assert.equal(byAddr.get("0xstranger")!.label, "0xstranger");
  assert.equal(byAddr.get("0xstranger")!.bucket, "unknown");
});
