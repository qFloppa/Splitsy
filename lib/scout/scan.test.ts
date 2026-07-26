import { test } from "node:test";
import assert from "node:assert/strict";
import { runScout, type ScanDeps } from "./scan.ts";
import { emptyParsedBill, type ParsedBill } from "../snapsplit.ts";

const img = { imageBase64: "x", mimeType: "image/jpeg", bytes: 500_000, width: 1200, height: 1600 };

const billWith = (over: Partial<ParsedBill>): ParsedBill => ({ ...emptyParsedBill, ...over });

function deps(overrides: Partial<ScanDeps> = {}): ScanDeps {
  return {
    dailyCapUsd: 0.05,
    spentTodayUsd: async () => 0,
    record: async () => {},
    parseDirect: async () => billWith({ merchant: "Fallback", total: 10, confidence: 0.99 }),
    pay: async (path) => ({
      result: { bill: billWith({ merchant: "Cafe", total: 10, confidence: 0.95 }) },
      amountUsd: path.includes("ocr") ? 0.005 : 0.001,
      tx: "0xtx",
    }),
    ...overrides,
  };
}

test("declines a garbage image without paying", async () => {
  const r = await runScout({ ...img, bytes: 100 }, deps());
  assert.equal(r.bill, null);
  assert.ok(r.declined);
  assert.equal(r.payments.length, 0);
});

test("pays once for a high-confidence USD scan (no FX)", async () => {
  const r = await runScout(img, deps());
  assert.equal(r.payments.length, 1);
  assert.equal(r.payments[0].endpoint, "/api/ocr");
  assert.equal(r.bill?.merchant, "Cafe");
  assert.equal(r.totalSpentUsd, 0.005);
  assert.equal(r.degraded, false);
});

test("pays twice when the first parse is unsure and budget allows", async () => {
  let call = 0;
  const r = await runScout(
    img,
    deps({
      pay: async (path) => {
        if (!path.includes("ocr")) return { result: {}, amountUsd: 0.001, tx: "0xfx" };
        call += 1;
        return {
          result: { bill: billWith({ total: 10, confidence: call === 1 ? 0.5 : 0.9 }) },
          amountUsd: 0.005,
          tx: "0xtx",
        };
      },
    }),
  );
  assert.equal(r.payments.filter((p) => p.endpoint === "/api/ocr").length, 2);
  assert.equal(r.bill?.confidence, 0.9); // kept the better of the two
  assert.equal(r.totalSpentUsd, 0.01);
});

test("keeps the first parse when the second opinion is worse", async () => {
  let call = 0;
  const r = await runScout(
    img,
    deps({
      pay: async () => {
        call += 1;
        return {
          result: { bill: billWith({ merchant: call === 1 ? "First" : "Second", confidence: call === 1 ? 0.5 : 0.2 }) },
          amountUsd: 0.005,
          tx: "0xtx",
        };
      },
    }),
  );
  assert.equal(r.bill?.merchant, "First");
  assert.equal(r.payments.length, 2); // paid for the second look regardless
});

test("skips the second opinion when the cap cannot cover it", async () => {
  const r = await runScout(
    img,
    deps({
      spentTodayUsd: async () => 0.043, // room for one $0.005 call, not two
      pay: async () => ({ result: { bill: billWith({ total: 10, confidence: 0.4 }) } , amountUsd: 0.005, tx: "0xtx" }),
    }),
  );
  assert.equal(r.payments.length, 1);
  assert.equal(r.bill?.confidence, 0.4); // shipped the unsure parse rather than overspend
});

test("pays FX for a foreign-currency bill", async () => {
  const r = await runScout(
    img,
    deps({
      pay: async (path) =>
        path.includes("ocr")
          ? { result: { bill: billWith({ currency: "EUR", total: 10, confidence: 0.95 }) }, amountUsd: 0.005, tx: "0xtx" }
          : { result: { amountUsd: 11.2, rate: 1.12, source: "EUR" }, amountUsd: 0.001, tx: "0xfx" },
    }),
  );
  assert.deepEqual(
    r.payments.map((p) => p.endpoint),
    ["/api/ocr", "/api/fx"],
  );
  assert.equal(r.fx?.amountUsd, 11.2);
  assert.equal(r.totalSpentUsd, 0.006);
});

test("skipFx leaves the FX buy to the caller", async () => {
  const r = await runScout(
    { ...img, skipFx: true },
    deps({
      pay: async (path) =>
        path.includes("ocr")
          ? { result: { bill: billWith({ currency: "EUR", total: 10, confidence: 0.95 }) }, amountUsd: 0.005, tx: "0xtx" }
          : { result: {}, amountUsd: 0.001, tx: "0xfx" },
    }),
  );
  assert.deepEqual(
    r.payments.map((p) => p.endpoint),
    ["/api/ocr"],
  );
  assert.equal(r.fx, undefined);
  assert.equal(r.bill?.currency, "EUR"); // still a foreign bill, just unconverted
});

test("budget exhausted before any pay degrades to the unpaid parse", async () => {
  const r = await runScout(img, deps({ spentTodayUsd: async () => 0.05 }));
  assert.equal(r.payments.length, 0);
  assert.equal(r.bill?.merchant, "Fallback");
  assert.equal(r.degraded, true);
  assert.equal(r.budgetRemainingUsd, 0);
});

test("a failed paid call degrades to the unpaid parse", async () => {
  const r = await runScout(
    img,
    deps({
      pay: async () => {
        throw new Error("facilitator down");
      },
    }),
  );
  assert.equal(r.bill?.merchant, "Fallback");
  assert.equal(r.degraded, true);
  assert.equal(r.payments.length, 0);
});

test("reports declined when the paid path and the fallback both fail", async () => {
  const r = await runScout(
    img,
    deps({
      pay: async () => {
        throw new Error("facilitator down");
      },
      parseDirect: async () => {
        throw new Error("scanner down");
      },
    }),
  );
  assert.equal(r.bill, null);
  assert.ok(r.declined);
});

test("records every payment it makes", async () => {
  const recorded: Array<{ endpoint: string; amountUsd: number }> = [];
  await runScout(
    img,
    deps({
      record: async (_d, endpoint, amountUsd) => {
        recorded.push({ endpoint, amountUsd });
      },
      pay: async (path) =>
        path.includes("ocr")
          ? { result: { bill: billWith({ currency: "GBP", total: 10, confidence: 0.95 }) }, amountUsd: 0.005, tx: "0xtx" }
          : { result: { amountUsd: 12 }, amountUsd: 0.001, tx: "0xfx" },
    }),
  );
  assert.deepEqual(recorded, [
    { endpoint: "/api/ocr", amountUsd: 0.005 },
    { endpoint: "/api/fx", amountUsd: 0.001 },
  ]);
});
