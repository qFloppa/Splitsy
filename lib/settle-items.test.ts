import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSettleItems,
  clearsSection,
  settleItemId,
  withHeldSections,
  type OwnedDebt,
  type SettleItem,
  type SocialDebt,
} from "./settle-items.ts";

const ACCOUNT_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const ACCOUNT_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const SPLITTER = "0xcccccccccccccccccccccccccccccccccccccccc" as const;

// Narrow by kind in one place, so every assertion below can read the fields that
// only its own variant carries.
function pick<K extends SettleItem["kind"]>(items: SettleItem[], kind: K) {
  return items.filter((item): item is Extract<SettleItem, { kind: K }> => item.kind === kind);
}

// A debt the signed-in user owes. Defaults describe a plain, open, non-escrow
// bill; each test overrides only the field it is about.
function debt(over: Partial<OwnedDebt> = {}): OwnedDebt {
  return {
    billId: 1n,
    account: ACCOUNT_A,
    via: "wallet",
    splitter: SPLITTER,
    metadataHash: "0x00",
    totalOwed: 100_000_000n,
    totalPaid: 0n,
    claimed: 0n,
    dueDate: 0n,
    escrowUntilFull: false,
    participantList: [],
    owed: 10_000_000n,
    paid: 0n,
    remaining: 10_000_000n,
    claimable: 0n,
    ...over,
  } as OwnedDebt;
}

function social(over: Partial<SocialDebt> = {}): SocialDebt {
  return { id: "s1", amountUsd: 5, merchant: "Tesco", creator: null, ...over };
}

test("section id combines bill and account, so one bill on two wallets is two sections", () => {
  assert.equal(settleItemId(1n, ACCOUNT_A), `1:${ACCOUNT_A.toLowerCase()}`);
  assert.notEqual(settleItemId(1n, ACCOUNT_A), settleItemId(1n, ACCOUNT_B));

  const items = buildSettleItems({
    socialDebts: [],
    walletDebts: [debt({ account: ACCOUNT_A }), debt({ account: ACCOUNT_B })],
    splitterBills: [],
    nowSeconds: 0n,
  });
  const debts = pick(items, "debt-wallet");
  assert.equal(debts.length, 2);
  assert.equal(new Set(debts.map((d) => d.id)).size, 2);
});

test("social debts are never editable, wallet debts are", () => {
  const items = buildSettleItems({
    socialDebts: [social()],
    walletDebts: [debt({ via: "social" }), debt({ billId: 2n, via: "wallet" })],
    splitterBills: [],
    nowSeconds: 0n,
  });
  assert.equal(pick(items, "debt-social")[0].editable, false);
  const wallets = pick(items, "debt-wallet");
  assert.equal(wallets.find((d) => d.debt.via === "social")?.editable, false);
  assert.equal(wallets.find((d) => d.debt.via === "wallet")?.editable, true);
});

test("the newest bill sorts first, whatever its due date or amount", () => {
  const items = buildSettleItems({
    socialDebts: [],
    walletDebts: [
      debt({ billId: 1n, dueDate: 0n, remaining: 30_000_000n }),
      debt({ billId: 4n, dueDate: 500n }),
      debt({ billId: 2n, dueDate: 100n }),
      debt({ billId: 3n, dueDate: 0n, remaining: 90_000_000n }),
    ],
    splitterBills: [],
    nowSeconds: 0n,
  });
  const ids = pick(items, "debt-wallet").map((i) => i.debt.billId);
  assert.deepEqual(ids, [4n, 3n, 2n, 1n]);
});

test("off-chain social debts keep their newest-first arrival order, under the on-chain run", () => {
  const items = buildSettleItems({
    socialDebts: [social({ id: "new" }), social({ id: "old" })],
    walletDebts: [debt({ billId: 1n }), debt({ billId: 2n })],
    splitterBills: [],
    nowSeconds: 0n,
  });
  const ids = items.filter((i) => i.kind === "debt-wallet" || i.kind === "debt-social").map((i) => i.id);
  assert.deepEqual(ids, [`2:${ACCOUNT_A.toLowerCase()}`, `1:${ACCOUNT_A.toLowerCase()}`, "social:new", "social:old"]);
});

test("claims read newest-first as well", () => {
  const items = buildSettleItems({
    socialDebts: [],
    walletDebts: [],
    splitterBills: [debt({ billId: 5n, claimable: 1n }), debt({ billId: 9n, claimable: 1n })],
    nowSeconds: 0n,
  });
  assert.deepEqual(
    pick(items, "claim").map((i) => i.debt.billId),
    [9n, 5n],
  );
});

test("a refund-only row survives and sorts to the end of the debt run", () => {
  // escrowed, past due, still short, and this payer has money in — refundable
  // with nothing remaining. Filtering on `remaining > 0n` would drop it.
  const refundOnly = debt({
    billId: 9n,
    remaining: 0n,
    paid: 10_000_000n,
    totalPaid: 10_000_000n,
    escrowUntilFull: true,
    dueDate: 100n,
  });
  const items = buildSettleItems({
    socialDebts: [],
    walletDebts: [refundOnly, debt({ billId: 1n, dueDate: 50n })],
    splitterBills: [],
    nowSeconds: 999n,
  });
  const debts = pick(items, "debt-wallet");
  assert.equal(debts.length, 2);
  assert.equal(debts.at(-1)?.debt.billId, 9n);
  assert.equal(debts.at(-1)?.action, "refund");
  assert.equal(debts[0].action, "pay");
});

test("the divider appears only when both sides have rows", () => {
  const claim = debt({ billId: 7n, claimable: 60_000_000n });

  const both = buildSettleItems({ socialDebts: [social()], walletDebts: [], splitterBills: [claim], nowSeconds: 0n });
  assert.equal(pick(both, "divider").length, 1);

  const debtsOnly = buildSettleItems({ socialDebts: [social()], walletDebts: [], splitterBills: [], nowSeconds: 0n });
  assert.equal(pick(debtsOnly, "divider").length, 0);

  const claimsOnly = buildSettleItems({ socialDebts: [], walletDebts: [], splitterBills: [claim], nowSeconds: 0n });
  assert.equal(pick(claimsOnly, "divider").length, 0);
});

test("the divider carries the claim count and total", () => {
  const items = buildSettleItems({
    socialDebts: [social()],
    walletDebts: [],
    splitterBills: [debt({ billId: 7n, claimable: 60_000_000n }), debt({ billId: 8n, claimable: 18_000_000n })],
    nowSeconds: 0n,
  });
  const divider = pick(items, "divider")[0];
  assert.equal(divider?.claimCount, 2);
  assert.equal(divider?.totalUsd, 78);
});

test("only claimable bills become claim sections", () => {
  const items = buildSettleItems({
    socialDebts: [],
    walletDebts: [],
    splitterBills: [debt({ billId: 7n, claimable: 60_000_000n }), debt({ billId: 8n, claimable: 0n })],
    nowSeconds: 0n,
  });
  const claims = pick(items, "claim");
  assert.equal(claims.length, 1);
  assert.equal(claims[0].debt.billId, 7n);
});

test("an escrowed bill past its due date and still short becomes a failed claim section", () => {
  const items = buildSettleItems({
    socialDebts: [],
    walletDebts: [],
    splitterBills: [debt({ billId: 8n, claimable: 0n, escrowUntilFull: true, dueDate: 100n, totalPaid: 1n })],
    nowSeconds: 999n,
  });
  const failed = pick(items, "claim-failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].debt.billId, 8n);
});

test("only a flow that covers the whole section clears it", () => {
  const items = buildSettleItems({
    socialDebts: [social()],
    walletDebts: [debt({ billId: 3n, remaining: 3_030_000n })],
    splitterBills: [debt({ billId: 7n, claimable: 60_000_000n })],
    nowSeconds: 0n,
  });
  const wallet = pick(items, "debt-wallet")[0];
  const claim = pick(items, "claim")[0];
  const socialItem = pick(items, "debt-social")[0];

  assert.equal(clearsSection(wallet, { kind: "pay", amountLabel: "3.03" }), true);
  assert.equal(clearsSection(wallet, { kind: "pay", amountLabel: "2.00" }), false);
  // Bridging moves USDC to Arc — the debt is untouched, whatever the amount.
  assert.equal(clearsSection(wallet, { kind: "bridge", amountLabel: "3.03" }), false);
  assert.equal(clearsSection(claim, { kind: "claim", amountLabel: "60.00" }), true);
  assert.equal(clearsSection(claim, { kind: "claim", amountLabel: "20.00" }), false);
  assert.equal(clearsSection(socialItem, { kind: "pay", amountLabel: "5.00" }), true);
  assert.equal(clearsSection(undefined, { kind: "pay", amountLabel: "5.00" }), false);
});

test("a settled section is held in its old slot after the refresh drops it", () => {
  const before = buildSettleItems({
    socialDebts: [],
    walletDebts: [debt({ billId: 1n }), debt({ billId: 2n }), debt({ billId: 3n })],
    splitterBills: [],
    nowSeconds: 0n,
  });
  const paid = before[1];
  // What the next registry read looks like once bill 2 is settled: gone.
  const after = before.filter((item) => item.id !== paid.id);
  const held = withHeldSections(after, [{ index: 1, item: paid }]);

  assert.deepEqual(
    held.map((item) => item.id),
    before.map((item) => item.id),
  );
});

test("a held section is dropped once the live read carries it again", () => {
  const items = buildSettleItems({
    socialDebts: [],
    walletDebts: [debt({ billId: 1n }), debt({ billId: 2n })],
    splitterBills: [],
    nowSeconds: 0n,
  });
  // A partial payment leaves the row live; the snapshot must not double it.
  const held = withHeldSections(items, [{ index: 0, item: items[0] }]);
  assert.equal(held.length, items.length);
  assert.equal(new Set(held.map((item) => item.id)).size, held.length);
});

test("several held sections keep their order, and a stale index still lands", () => {
  const before = buildSettleItems({
    socialDebts: [],
    walletDebts: [debt({ billId: 1n }), debt({ billId: 2n }), debt({ billId: 3n })],
    splitterBills: [],
    nowSeconds: 0n,
  });
  const held = withHeldSections(
    [before.at(-1)!],
    // Deliberately out of order, and index 2 is past the end of a one-item list.
    [
      { index: 2, item: before[2] },
      { index: 0, item: before[0] },
    ],
  );
  assert.deepEqual(
    held.map((item) => item.id),
    [before[0].id, before.at(-1)!.id, before[2].id],
  );
});

test("the end card is always last, even when nothing is pending", () => {
  const empty = buildSettleItems({ socialDebts: [], walletDebts: [], splitterBills: [], nowSeconds: 0n });
  assert.equal(empty.length, 1);
  assert.equal(empty[0].kind, "end");

  const full = buildSettleItems({
    socialDebts: [social()],
    walletDebts: [debt()],
    splitterBills: [debt({ billId: 7n, claimable: 60_000_000n })],
    nowSeconds: 0n,
  });
  assert.equal(full.at(-1)?.kind, "end");
});
