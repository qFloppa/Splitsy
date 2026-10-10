import { test } from "node:test";
import assert from "node:assert/strict";
import { archiveRows, archiveTotals, depositKey, type ArchiveInput, type IouJournalRow } from "./iou-archive.ts";

const row = (over: Partial<IouJournalRow> = {}): IouJournalRow => ({
  id: "j1",
  signerAddress: "0xaaa",
  kind: "settle",
  counterpartyLabel: "@dani",
  counterpartyAddress: "0xbbb",
  amountUsdc: "42.000000",
  note: "the cab home",
  status: "open",
  registryAddress: null,
  billId: null,
  escrowAddress: null,
  escrowDepositId: null,
  txHash: "0xtransfer",
  createdAt: "2026-09-12T10:00:00.000Z",
  ...over,
});

const input = (over: Partial<ArchiveInput> = {}): ArchiveInput => ({
  journal: [],
  bills: new Map(),
  payments: new Map(),
  deposits: new Map(),
  people: new Map(),
  ...over,
});

test("an unpaid ask is not in the archive, and a paid one is", () => {
  const ask = row({ kind: "ask", billId: "7", registryAddress: "0xreg", txHash: "0xcreated" });
  const owes = new Map([["7", { totalOwed: 42000000n, totalPaid: 0n }]]);
  assert.equal(archiveRows(input({ journal: [ask], bills: owes })).length, 0, "unpaid ask must not land");

  const paid = new Map([["7", { totalOwed: 42000000n, totalPaid: 42000000n }]]);
  const legs = new Map([["7", { total: 42000000n, lastTxHash: "0xpaid", lastAt: 1790000000 }]]);
  const [landed] = archiveRows(input({ journal: [ask], bills: paid, payments: legs }));
  assert.equal(landed.direction, "owes-me");
  // The RECEIPT is the payment, not the creation — the creation hash is the
  // fallback for a bill whose legs could not be read.
  assert.equal(landed.txHash, "0xpaid");
  assert.equal(landed.at, 1790000000);
});

test("an ask the chain could not answer for stays out of the archive", () => {
  // A failed read is not "not paid", and it is not "paid" either — it is silence,
  // and silence must not become a "landed" row.
  const ask = row({ kind: "ask", billId: "7" });
  assert.equal(archiveRows(input({ journal: [ask] })).length, 0);
});

test("a paid ask whose legs are unreadable still lands, on the creation tx", () => {
  const ask = row({ kind: "ask", billId: "7", txHash: "0xcreated" });
  const paid = new Map([["7", { totalOwed: 10n, totalPaid: 10n }]]);
  const [landed] = archiveRows(input({ journal: [ask], bills: paid }));
  assert.equal(landed.txHash, "0xcreated");
});

test("a plain settle is landed by virtue of having been written", () => {
  const [landed] = archiveRows(input({ journal: [row()] }));
  assert.equal(landed.direction, "i-owe");
  assert.equal(landed.outcome, "settled");
  assert.equal(landed.txHash, "0xtransfer");
});

test("an escrowed settle is in-flight until its deposit is released", () => {
  const escrowed = row({
    status: "escrowed",
    escrowAddress: "0xESC",
    escrowDepositId: "9",
    txHash: "0xdeposit",
    counterpartyAddress: null,
  });
  const key = depositKey("0xESC", "9");
  assert.equal(key, "0xesc:9", "the key lowercases, matching escrow_deposits");

  const open = new Map([[key, { status: "open", releaseTxHash: null }]]);
  const [pending] = archiveRows(input({ journal: [escrowed], deposits: open }));
  assert.equal(pending.outcome, "in-flight");
  assert.equal(pending.txHash, null, "nothing released, so nothing to link");

  const released = new Map([[key, { status: "released", releaseTxHash: "0xrelease" }]]);
  const [done] = archiveRows(input({ journal: [escrowed], deposits: released }));
  assert.equal(done.outcome, "settled");
  assert.equal(done.txHash, "0xrelease");
});

test("an escrowed settle with no deposit row at all shows nothing", () => {
  const escrowed = row({ status: "escrowed", escrowAddress: "0xesc", escrowDepositId: "9" });
  assert.equal(archiveRows(input({ journal: [escrowed] })).length, 0);
});

test("the archive reads newest first, and is stable when two share a timestamp", () => {
  const same = { createdAt: "2026-09-12T10:00:00.000Z" };
  const rows = archiveRows(
    input({
      journal: [
        row({ id: "a", ...same }),
        row({ id: "b", ...same }),
        row({ id: "c", createdAt: "2026-09-14T10:00:00.000Z" }),
      ],
    }),
  );
  assert.deepEqual(
    rows.map((r) => r.id),
    ["c", "b", "a"],
  );
});

test("an unparseable timestamp sorts last rather than producing NaN", () => {
  const rows = archiveRows(input({ journal: [row({ id: "bad", createdAt: "not a date" }), row({ id: "ok" })] }));
  assert.deepEqual(
    rows.map((r) => r.id),
    ["ok", "bad"],
  );
  assert.equal(rows[1].at, 0);
});

test("a resolved counterparty travels as the parts of an identity, else just its label", () => {
  const known = row({ id: "k", counterpartyAddress: "0xBBB", counterpartyLabel: "@dani" });
  // A Discord IOU: the journal stored "@dani" because that is what the composer
  // had, and the provider only comes back with the address lookup — which is the
  // whole reason the archive resolves people rather than trusting the label.
  const [tagged] = archiveRows(
    input({
      journal: [known],
      people: new Map([["0xbbb", { handle: "dani", provider: "discord", avatarUrl: null }]]),
    }),
  );
  assert.deepEqual([tagged.handle, tagged.provider, tagged.address], ["dani", "discord", "0xBBB"]);

  // Nobody behind the address: the stored label is the only name this row has,
  // and no provider is invented for it.
  const [plain] = archiveRows(input({ journal: [row({ counterpartyAddress: null })] }));
  assert.deepEqual([plain.handle, plain.provider, plain.label], [null, null, "@dani"]);
});

test("the total counts what landed and excludes what is still in flight", () => {
  const escrowed = row({ id: "e", status: "escrowed", escrowAddress: "0xesc", escrowDepositId: "9" });
  const rows = archiveRows(
    input({
      journal: [row({ id: "a", amountUsdc: "10.500000" }), escrowed],
      deposits: new Map([[depositKey("0xesc", "9"), { status: "open", releaseTxHash: null }]]),
    }),
  );
  const totals = archiveTotals(rows);
  assert.equal(totals.count, 2, "both rows are in the archive");
  // One LANDED. An escrowed deposit has left the sender and reached nobody, so
  // calling it landed would be the mistake the ledger refuses to make.
  assert.equal(totals.settledCount, 1);
  assert.equal(totals.inFlight, 1);
  // 10.50 only: the escrowed 42 is not in anyone's wallet yet, and counting it
  // would make this disagree with the ledger's net.
  assert.equal(totals.settledUsd, 10.5);
});