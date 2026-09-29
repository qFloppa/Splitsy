import { normalizeParsedBill, type ParsedBill } from "./snapsplit.ts";
import { fetchWithRetry, isTransientUpstream } from "./retry.ts";

const DEFAULT_MODEL = process.env.RECEIPT_SCANNER_MODEL ?? "gemini-3.1-flash-lite";

// WHICH MODELS A CALLER MAY NAME, and why this is an allowlist rather than a
// validation regex.
//
// `model` reaches this function from the BODY of /api/ocr, which is a public
// x402 endpoint charging a FIXED $0.005 (lib/x402/pricing.ts). Two things follow
// from letting a caller choose freely, and both are real:
//
//   COST. A buyer pays the same $0.005 whichever model runs, so naming the most
//   expensive one available turns the endpoint into a subsidy. The price cannot
//   be defended without bounding the set.
//
//   THE URL. The value is interpolated into the request path below. A `?`, a `#`
//   or a `..` segment reshapes the request that carries our API key — the host is
//   fixed, so this is not full SSRF, but it can reach paths on googleapis.com
//   that this key was never meant to touch. A regex over "model-looking strings"
//   would still let most of that through; an allowlist cannot.
//
// The env-configured models are included so a deployment can pin its own default
// and second-opinion model without editing this list. Anything else is refused
// rather than silently replaced with the default: a buyer who asked for a model
// and got a different one has been quietly overcharged for the wrong thing.
const ALLOWED_MODELS = new Set(
  [
    "gemini-3.1-flash-lite",
    "gemini-flash-lite-latest",
    "gemini-3-flash",
    "gemini-3.1-flash",
    process.env.RECEIPT_SCANNER_MODEL,
    process.env.SCOUT_FALLBACK_MODEL,
  ].filter((m): m is string => Boolean(m)),
);

// Gemini takes the image inline as base64, so the body IS the cost driver: tokens
// scale with pixels, and nothing upstream of a paid endpoint bounds what a caller
// posts. 12 MB of base64 is ~9 MB of image, which matches the ceiling
// app/api/scout/scan/route.ts already applies to its own uploads — the two are the
// same limit on the same spend and should not disagree.
const MAX_IMAGE_BASE64_CHARS = 12 * 1024 * 1024;

export class OcrInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OcrInputError";
  }
}

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
  if (imageBase64.length > MAX_IMAGE_BASE64_CHARS) {
    throw new OcrInputError("That image is too large to scan. Use a smaller photo.");
  }

  const model = opts?.model ?? DEFAULT_MODEL;
  if (!ALLOWED_MODELS.has(model)) {
    throw new OcrInputError(`Unsupported model. Choose one of: ${[...ALLOWED_MODELS].join(", ")}.`);
  }

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
