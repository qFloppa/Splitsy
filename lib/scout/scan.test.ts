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
    // The default stands for "nothing was charged", which is what a pay() that
    // threw before reaching the facilitator leaves behind.
    settledByFailedPay: () => null,
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
  // The unpaid parse's own words, not a bare "Receipt scan failed." — the
  // reason is the whole difference between a busy model and a broken deploy.
  assert.equal(r.declined, "scanner down");
});

// The failure this exists for: the whole gemini-3.x family answering 503 at
// once while gemini-flash-lite-latest, on the same key, is fine. Scout buys one
// more opinion over the same x402 path rather than giving up.
test("buys a third opinion from the fallback model when the default one is down", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const r = await runScout(
    img,
    deps({
      pay: async (_path, body) => {
        const request = body as Record<string, unknown>;
        calls.push(request);
        // The gemini-3.x family is in the spike; only the fallback answers.
        if (request.model === "gemini-flash-lite-latest") {
          return { result: { bill: billWith({ merchant: "Rescue", total: 10, confidence: 0.9 }) }, amountUsd: 0.005, tx: "0x3" };
        }
        throw new Error("This model is currently experiencing high demand.");
      },
    }),
  );
  assert.equal(r.bill?.merchant, "Rescue");
  // Rescued by a paid parse, so the result is a real scan, not a degradation.
  assert.equal(r.degraded, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].model, "gemini-flash-lite-latest");
  // Same x402 buy as the one it stands in for — only the model differs.
  assert.equal(calls[0].model, undefined);
  assert.equal(calls[1].imageBase64, "x");
  assert.equal(r.payments.length, 1);
});

test("the fallback model is configurable", async () => {
  process.env.SCOUT_FALLBACK_MODEL = "another-lite";
  try {
    const calls: Array<Record<string, unknown>> = [];
    const r = await runScout(
      img,
      deps({
        pay: async (_path, body) => {
          const request = body as Record<string, unknown>;
          calls.push(request);
          if (request.model === "another-lite") {
            return { result: { bill: billWith({ merchant: "Rescue", confidence: 0.9 }) }, amountUsd: 0.005, tx: "0x3" };
          }
          throw new Error("503");
        },
      }),
    );
    assert.equal(r.bill?.merchant, "Rescue");
    assert.equal(calls[1].model, "another-lite");
  } finally {
    delete process.env.SCOUT_FALLBACK_MODEL;
  }
});

test("a 503 on the second opinion keeps the first parse rather than buying the fallback", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const r = await runScout(
    img,
    deps({
      pay: async (_path, body) => {
        const request = body as Record<string, unknown>;
        calls.push(request);
        // The first parse works but is unsure; the stricter second opinion is in
        // the spike, and the fallback model answers if asked.
        if (request.hq) throw new Error("503");
        return {
          result: { bill: billWith({ merchant: "Cafe", confidence: request.model ? 0.9 : 0.5 }) },
          amountUsd: 0.005,
          tx: "0xtx",
        };
      },
    }),
  );
  // One good parse is already paid for — no need to spend again for a rescue.
  assert.equal(r.bill?.merchant, "Cafe");
  assert.equal(calls.length, 2);
  assert.equal(r.payments.length, 1);
});

test("does not buy the fallback opinion when the cap cannot cover it", async () => {
  let pays = 0;
  const r = await runScout(
    img,
    deps({
      // Room for exactly one OCR call at 0.005.
      dailyCapUsd: 0.005,
      // The failed buy was charged, so the cap is now full.
      settledByFailedPay: () => ({ amountUsd: 0.005, tx: "0x0" }),
      pay: async () => {
        pays += 1;
        throw new Error("503");
      },
    }),
  );
  assert.equal(pays, 1);
  assert.equal(r.bill?.merchant, "Fallback");
  assert.equal(r.degraded, true);
});

// The payment-check header is read whether or not the handler succeeded, so a
// parse that failed was still charged for. Recording it is what keeps the
// receipt honest and the cap from being spent invisibly.
test("counts and records a purchase that settled and then failed", async () => {
  const recorded: Array<{ endpoint: string; amountUsd: number }> = [];
  const r = await runScout(
    img,
    deps({
      record: async (_d, endpoint, amountUsd) => {
        recorded.push({ endpoint, amountUsd });
      },
      settledByFailedPay: () => ({ amountUsd: 0.005, tx: "0xdead" }),
      pay: async () => {
        throw new Error("This model is currently experiencing high demand.");
      },
      parseDirect: async () => billWith({ merchant: "Fallback", confidence: 0.9 }),
    }),
  );
  // Two failed buys, both charged for, both recorded.
  assert.equal(r.totalSpentUsd, 0.01);
  assert.deepEqual(
    recorded.map((p) => p.amountUsd),
    [0.005, 0.005],
  );
  assert.equal(r.budgetRemainingUsd, 0.04);
});

test("an attempt that never reached the facilitator is not counted as spent", async () => {
  const r = await runScout(
    img,
    deps({
      settledByFailedPay: () => null,
      pay: async () => {
        throw new Error("Missing SCOUT_PRIVATE_KEY");
      },
    }),
  );
  assert.equal(r.totalSpentUsd, 0);
  assert.equal(r.payments.length, 0);
  assert.equal(r.degraded, true);
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
