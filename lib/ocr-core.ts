import { normalizeParsedBill, type ParsedBill } from "@/lib/snapsplit";

const RECEIPT_SCANNER_MODEL = process.env.RECEIPT_SCANNER_MODEL ?? "receipt-scanner-model";

// The receipt parse, extracted from /api/ocr so Scout can call it two ways:
// over HTTP as a paid x402 buy, or directly as the unpaid fallback when the
// paid path is unavailable. `hq` is the second-opinion pass — same model, a
// stricter prompt — worth paying for only when the first parse came back unsure.
export async function parseReceipt(
  imageBase64: string,
  mimeType: string,
  opts?: { hq?: boolean },
): Promise<ParsedBill> {
  const apiKey = process.env.RECEIPT_SCANNER_API_KEY;
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

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${RECEIPT_SCANNER_MODEL}:generateContent`,
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
  );

  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message ?? "Receipt scan failed.");

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
