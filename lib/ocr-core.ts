import { normalizeParsedBill, type ParsedBill } from "./snapsplit.ts";
import { fetchWithRetry, isTransientUpstream } from "./retry.ts";

const DEFAULT_MODEL = process.env.RECEIPT_SCANNER_MODEL ?? "gemini-3.1-flash-lite";

// The receipt parse, extracted from /api/ocr so Scout can call it two ways:
// over HTTP as a paid x402 buy, or directly as the unpaid fallback when the
// paid path is unavailable. `hq` triggers the second-opinion pass; `model`
// lets Scout swap in a different model for that pass (different weights = genuinely
// independent opinion, not just a re-prompt of the same model).
export async function parseReceipt(
  imageBase64: string,
  mimeType: string,
  opts?: { hq?: boolean; model?: string },
): Promise<ParsedBill> {
  const model = opts?.model ?? DEFAULT_MODEL;
  // Second-opinion pass uses a dedicated key so it can hit a different quota/project.
  const apiKey = (opts?.hq ? process.env.SCOUT_SECOND_OPINION_API_KEY : undefined)
    ?? process.env.RECEIPT_SCANNER_API_KEY;
  if (!apiKey) throw new Error("Missing RECEIPT_SCANNER_API_KEY on the server.");

  const prompt = [
    "Extract this receipt or bill into strict JSON only.",
    "Return this shape: { merchant, currency, subtotal, tax, tip, total, lineItems, confidence, notes }.",
    "lineItems must be an array of { description, quantity, amount }.",
    "Use ISO 4217 currency codes. Use numbers for money, not strings.",
    "confidence is 0..1 for how sure you are the extraction is correct.",
    opts?.hq
      ? "Be extra rigorous: re-read totals digit by digit, verify lineItems sum near the subtotal, and lower confidence if anything is ambiguous."
      : "If a field is missing, use 0 or an empty string and explain uncertainty in notes.",
  ].join(" ");

  const response = await fetchWithRetry(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { inline_data: { mime_type: mimeType, data: imageBase64 } },
              { text: prompt },
            ],
          },
        ],
        generationConfig: { responseMimeType: "application/json", temperature: 0 },
      }),
    },
    {
      // The upstream's own reason ("high demand") is the only thing that tells
      // this apart from a real refusal, and it is gone once the retry runs.
      onRetryError: (message) => console.warn(`[ocr] ${model} ${message}, retrying`),
    },
  );

  const payload = await response.json();
  // An exhausted retry means the model is still busy. Say that, rather than the
  // bare "Receipt scan failed." this used to fall through to — which read as
  // something being wrong here and sent whoever hit it looking in this repo.
  if (!response.ok) {
    throw new Error(
      isTransientUpstream(response.status)
        ? `The receipt scanner is busy right now (HTTP ${response.status}). Try again in a moment.`
        : payload?.error?.message ?? "Receipt scan failed.",
    );
  }

  const text = payload?.candidates?.[0]?.content?.parts
    ?.map((part: { text?: string }) => part.text ?? "")
    .join("")
    .trim();
  if (!text) throw new Error("The receipt scanner returned no bill data.");

  try {
    return normalizeParsedBill(JSON.parse(stripJsonFences(text)));
  } catch {
    throw new Error("The receipt scanner returned malformed bill data.");
  }
}

function stripJsonFences(value: string) {
  return value.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "");
}
