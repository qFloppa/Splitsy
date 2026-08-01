// The one judgment in the debtor-side agent that a rule cannot make.
//
// lib/autopay.ts is a pure deterministic function — caps, a score floor, a hash
// comparison. That is a policy engine, and a standing mandate plus if-statements
// is verifiable direct debit. What it never asks is whether the bill is
// REASONABLE: requireVerifiedHash proves only that the preimage recomputes to
// the on-chain metadataHash, which says nothing about whether the merchant,
// total, and share hang together at all. That question is unbounded OCR'd text,
// so it is the one place a model earns its keep — and it is only survivable
// because AutopayMandate.sol bounds the spend absolutely regardless of what this
// file returns.
//
// What it does NOT see: line items. They are in neither the commitment
// (lib/bill-metadata.ts) nor the published row (lib/onchain-bill-preimage-repo.ts)
// — only a receipt URL is. So this judges headline coherence only, never "did
// this person actually order the wine". The prompt must not ask for more than
// that: an uneven share is the entire point of a bill-splitting app, and with no
// line items an above-even share is unjustifiable by construction.
//
// Runs ONLY after decideAutopay returns `pay`. Rules are free and this is not,
// so a bill already rejected by a cap never costs a call.
//
// Same provider and shape as lib/ocr-core.ts: raw fetch, JSON mode, temperature
// 0. No SDK, no new dependency.
import type { BillPreimage } from "./bill-metadata.ts";

const DEFAULT_MODEL = process.env.AUTOPAY_REVIEW_MODEL ?? "gemini-3.1-flash-lite";

// The slug written to autopay_log when the review could not reach a verdict.
// The model's own prose is written verbatim instead when it DID reach one —
// app/SettlementAgentsPanel.tsx renders an unmapped reason as-is, so no slug is
// needed for the interesting case.
export const REVIEW_UNAVAILABLE = "review_unavailable";

export type ReviewVerdict = { approve: boolean; reason: string };

export type ReviewInput = {
  preimage: BillPreimage;
  shareUsdc: number;
  participantCount: number;
  creatorScore: number | null;
};

// ponytail: one call per debtor per bill. A ten-person bill with ten live
// mandates is ten calls; batch to one call per bill returning a verdict per
// participant if that ever shows up in the bill.

const FAIL_CLOSED: ReviewVerdict = { approve: false, reason: REVIEW_UNAVAILABLE };

// Separated from the fetch so the failure directions are testable without a
// network. Anything it cannot read confidently is a refusal, never an approval.
export function parseReviewVerdict(raw: string | null): ReviewVerdict {
  if (!raw) return FAIL_CLOSED;

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFences(raw.trim()));
  } catch {
    return FAIL_CLOSED;
  }

  if (!parsed || typeof parsed !== "object") return FAIL_CLOSED;
  const obj = parsed as { approve?: unknown; reason?: unknown };
  if (typeof obj.approve !== "boolean") return FAIL_CLOSED;

  const reason = typeof obj.reason === "string" && obj.reason.trim() ? obj.reason.trim() : "";
  if (obj.approve) {
    return { approve: true, reason: reason || "Bill contents look consistent with this share." };
  }
  // A refusal with no sentence is still a refusal, but the log must say
  // something a person can act on.
  return { approve: false, reason: reason || "The agent could not justify this bill's contents." };
}

// Gemini fences its JSON often enough that lib/ocr-core.ts carries this same
// helper despite also setting responseMimeType: "application/json". Duplicated
// rather than imported: ocr-core.ts imports the "@/lib/snapsplit" alias, which
// `node --test --experimental-strip-types` cannot resolve, so importing from it
// would stop this module's test from loading at all.
function stripJsonFences(value: string) {
  return value.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "");
}

export async function reviewBill(input: ReviewInput): Promise<ReviewVerdict> {
  const apiKey = process.env.RECEIPT_SCANNER_API_KEY;
  // No key is not "approve anyway". A deployment that cannot review must not
  // silently downgrade to paying without one.
  if (!apiKey) {
    console.warn("[autopay-review] no RECEIPT_SCANNER_API_KEY; refusing every review");
    return FAIL_CLOSED;
  }

  try {
    // Inside the try on purpose. `preimage` reaches callers as `BillPreimage |
    // null` (lib/autopay.ts) off a Supabase row whose participant_labels column
    // is nullable, so this build can throw a TypeError — and a rejected promise
    // is NOT a refusal. A caller that treats a throw as "review not applicable"
    // would pay without a review, so every path here must return a verdict.
    const prompt = [
      "You are reviewing a shared bill on behalf of one person before their agent pays their share.",
      "Return strict JSON only, shape: { approve: boolean, reason: string }.",
      "reason must be ONE sentence, addressed to the payer, in plain language.",
      "You are given ONLY the fields below. There are no line items, so you cannot check",
      "what this person ordered — shares are often deliberately uneven, and a share above",
      "the even split is NOT by itself a reason to refuse.",
      "Approve when the bill is coherent and the share is plausible for it.",
      "Refuse when the total is wildly implausible for this kind of merchant, when the share",
      "exceeds the whole bill, when the share is so far above an even split that no ordering",
      "would explain it, or when the labels contradict the stated number of people.",
      "A creator with no reputation history is neutral, never a reason to refuse on its own.",
      "",
      "Units: the bill total and the even split are in the bill's own currency, while this",
      "person's share is in USDC. Do NOT compare them numerically unless the currency is USD.",
      "",
      `Merchant: ${input.preimage.merchant || "(none given)"}`,
      `Currency: ${input.preimage.currency}`,
      `Bill total: ${input.preimage.total}`,
      `People on the bill: ${input.participantCount}`,
      `Even split would be: ${(input.preimage.total / Math.max(input.participantCount, 1)).toFixed(2)}`,
      `This person's share (USDC): ${input.shareUsdc}`,
      `Creator reputation score: ${input.creatorScore === null ? "no history" : input.creatorScore}`,
      `Participant labels: ${input.preimage.participantLabels.join(", ")}`,
    ].join("\n");

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0 },
        }),
        // A model that hangs must not hold a webhook open. A timeout is a
        // refusal, which is the safe direction.
        signal: AbortSignal.timeout(15_000),
      },
    );
    // An expired key, a 429, or a shape change all refuse identically, and
    // because require_bill_review defaults true that silently halts ALL autopay.
    // Log enough to correlate it server-side — never the key, never the model's
    // text (it quotes the bill).
    if (!response.ok) {
      console.warn(`[autopay-review] model returned HTTP ${response.status}; refusing`);
      return FAIL_CLOSED;
    }

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    // Join every part, as lib/ocr-core.ts does: a leading thought part or a split
    // response would otherwise fail closed forever on a healthy deployment.
    const text = data.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? "")
      .join("")
      .trim();
    return parseReviewVerdict(text || null);
  } catch (error) {
    console.warn(
      "[autopay-review] review call failed; refusing:",
      error instanceof Error ? error.message : error,
    );
    return FAIL_CLOSED;
  }
}
