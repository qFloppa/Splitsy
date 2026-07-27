import { PRICES } from "@/lib/x402/pricing";
import { CONFIDENCE_THRESHOLD } from "@/lib/scout/decide";

// Prices and the confidence gate are IMPORTED, never restated. This page must
// not be able to advertise a price the seller does not charge, and the two
// modules are pure — no next/server, no viem — so they are safe on the client.
export const OCR_PRICE = PRICES["/api/ocr"];
export const FX_PRICE = PRICES["/api/fx"];
export const THRESHOLD = CONFIDENCE_THRESHOLD.toFixed(2);

// SCOUT_DAILY_CAP_USDC's default from lib/scout/deps.ts. Not importable — that
// module pulls in next/server and viem — so it is restated here. The live
// dailyCapUsd from /api/scout/stats supersedes it where the fetch succeeds.
export const DEMO_CAP = "$0.050";

// Two OCR calls plus one FX call: 0.005 + 0.005 + 0.001. Kept as a constant so
// the left pane's counter and the closing transcript line cannot disagree.
export const TOTAL_SPEND = "$0.011";

// req/res/note are spelled as three members rather than one with a union
// `kind`, because TypeScript only subtracts a member in a negative narrowing
// branch when its discriminant is a single literal — grouped, `line.value`
// stays unreachable after the early returns in TranscriptLine.
export type Line =
  | { kind: "req"; text: string }
  | { kind: "res"; text: string }
  | { kind: "note"; text: string }
  | { kind: "field"; text: string; value: string; note?: string }
  | { kind: "check"; text: string; value: string; state: "ok" | "warn" };

export type Act = { step: string; label: string; lines: Line[] };

// Each act maps to one rail step and one block of transcript. Field names,
// header names and values below are the ones lib/x402/seller.ts actually emits
// — see the traceability table in the design spec.
export const ACTS: Act[] = [
  {
    step: "Assess",
    label: "assess",
    lines: [
      { kind: "req", text: "scout.assess(receipt.jpg)" },
      { kind: "check", text: "image size", value: `1.4 MB ≥ 8 KB`, state: "ok" },
      { kind: "check", text: "resolution", value: "1290 × 1720 ≥ 200 px", state: "ok" },
      { kind: "check", text: "budget", value: `${DEMO_CAP} left ≥ ${OCR_PRICE}`, state: "ok" },
    ],
  },
  {
    step: "402",
    label: "challenge",
    lines: [
      { kind: "req", text: "POST /api/ocr" },
      { kind: "res", text: "402 Payment Required" },
      { kind: "note", text: "PAYMENT-REQUIRED (base64)" },
      { kind: "field", text: "scheme", value: '"exact"' },
      { kind: "field", text: "network", value: '"eip155:5042002"', note: "Arc Testnet" },
      { kind: "field", text: "asset", value: "0x3600…0000", note: "USDC" },
      { kind: "field", text: "amount", value: '"5000"', note: OCR_PRICE },
      { kind: "field", text: "maxTimeoutSeconds", value: "608400" },
      { kind: "field", text: "extra.name", value: '"GatewayWalletBatched"' },
    ],
  },
  {
    step: "Sign",
    label: "sign",
    lines: [
      { kind: "req", text: "sign EIP-3009 authorization" },
      { kind: "note", text: "offchain · Scout sends no transaction · zero gas" },
      { kind: "req", text: "POST /api/ocr" },
      { kind: "field", text: "payment-signature", value: "eyJ4NDAyVmVyc2lvbiI6Mi…" },
    ],
  },
  {
    step: "Settle",
    label: "settle",
    lines: [
      { kind: "note", text: "facilitator.verify()  →  isValid" },
      { kind: "note", text: "facilitator.settle()  →  batched by Circle Gateway" },
      { kind: "res", text: "200 OK" },
      { kind: "field", text: "PAYMENT-RESPONSE", value: "transaction 0x9f1c…4b2e" },
      { kind: "check", text: "ledger", value: `earned ${OCR_PRICE}`, state: "ok" },
    ],
  },
  {
    step: "Second opinion",
    label: "retry",
    lines: [
      { kind: "check", text: "confidence", value: `0.62 < ${THRESHOLD}`, state: "warn" },
      { kind: "req", text: "POST /api/ocr   { hq: true }" },
      { kind: "res", text: "200 OK   confidence 0.94" },
      { kind: "note", text: "pickBetterParse → keep the high-quality parse" },
      { kind: "check", text: "ledger", value: `earned ${OCR_PRICE}`, state: "ok" },
    ],
  },
  {
    step: "FX",
    label: "fx",
    lines: [
      { kind: "note", text: "bill currency EUR ≠ USD" },
      { kind: "req", text: `POST /api/fx   ${FX_PRICE}` },
      { kind: "res", text: "200 OK   { rate, source, asOf }" },
      { kind: "check", text: "run complete", value: `spent ${TOTAL_SPEND}`, state: "ok" },
    ],
  },
];

export const STEPS = ACTS.map((act) => act.step);
export const STEP_LABELS = ACTS.map((act) => act.label);
