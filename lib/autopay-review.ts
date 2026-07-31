// The one judgment in the debtor-side agent that a rule cannot make.
//
// lib/autopay.ts is a pure deterministic function — caps, a score floor, a hash
// comparison. That is a policy engine, and a standing mandate plus if-statements
// is verifiable direct debit. What it never asks is whether the bill is
// REASONABLE: requireVerifiedHash proves only that the preimage recomputes to
// the on-chain metadataHash, which says nothing about whether the contents make
// sense or whether this person's share matches what is attributed to them.
// That question is unbounded OCR'd text, so it is the one place a model earns
// its keep — and it is only survivable because AutopayMandate.sol bounds the
// spend absolutely regardless of what this file returns.
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
    parsed = JSON.parse(raw);
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

export async function reviewBill(input: ReviewInput): Promise<ReviewVerdict> {
  const apiKey = process.env.RECEIPT_SCANNER_API_KEY;
  // No key is not "approve anyway". A deployment that cannot review must not
  // silently downgrade to paying without one.
  if (!apiKey) return FAIL_CLOSED;

  const prompt = [
    "You are reviewing a shared bill on behalf of one person before their agent pays their share.",
    "Return strict JSON only, shape: { approve: boolean, reason: string }.",
    "reason must be ONE sentence, addressed to the payer, in plain language.",
    "Approve when the bill is internally coherent and the share is proportionate.",
    "Refuse when the total does not match the line items, when the share is far above",
    "an even split without the line items justifying it, or when the merchant and items",
    "are incoherent with each other.",
    "A creator with no reputation history is neutral, never a reason to refuse on its own.",
    "",
    `Merchant: ${input.preimage.merchant || "(none given)"}`,
    `Currency: ${input.preimage.currency}`,
    `Bill total: ${input.preimage.total}`,
    `People on the bill: ${input.participantCount}`,
    `Even split would be: ${(input.preimage.total / Math.max(input.participantCount, 1)).toFixed(2)}`,
    `This person's share: ${input.shareUsdc}`,
    `Creator reputation score: ${input.creatorScore === null ? "no history" : input.creatorScore}`,
    `Participant labels: ${input.preimage.participantLabels.join(", ")}`,
  ].join("\n");

  try {
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
    if (!response.ok) return FAIL_CLOSED;

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    return parseReviewVerdict(data.candidates?.[0]?.content?.parts?.[0]?.text ?? null);
  } catch {
    return FAIL_CLOSED;
  }
}
