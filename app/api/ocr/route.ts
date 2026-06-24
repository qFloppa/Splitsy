import { normalizeParsedBill } from "@/lib/snapsplit";

export const runtime = "nodejs";

const RECEIPT_SCANNER_MODEL = process.env.RECEIPT_SCANNER_MODEL ?? "receipt-scanner-model";
const MAX_INLINE_BYTES = 12 * 1024 * 1024;

export async function POST(request: Request) {
  const apiKey = process.env.RECEIPT_SCANNER_API_KEY;

  if (!apiKey) {
    return Response.json(
      { error: "Missing RECEIPT_SCANNER_API_KEY on the server." },
      { status: 500 },
    );
  }

  const formData = await request.formData();
  const file = formData.get("image");

  if (!(file instanceof File)) {
    return Response.json({ error: "Upload a bill image." }, { status: 400 });
  }

  if (!file.type.startsWith("image/")) {
    return Response.json({ error: "The uploaded file must be an image." }, { status: 400 });
  }

  if (file.size > MAX_INLINE_BYTES) {
    return Response.json({ error: "Image is too large for inline OCR. Use a smaller photo." }, { status: 400 });
  }

  const imageBytes = Buffer.from(await file.arrayBuffer());
  const prompt = [
    "Extract this receipt or bill into strict JSON only.",
    "Return this shape: { merchant, currency, subtotal, tax, tip, total, lineItems, confidence, notes }.",
    "lineItems must be an array of { description, quantity, amount }.",
    "Use ISO 4217 currency codes. Use numbers for money, not strings.",
    "If a field is missing, use 0 or an empty string and explain uncertainty in notes.",
  ].join(" ");

  const scannerResponse = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${RECEIPT_SCANNER_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                inline_data: {
                  mime_type: file.type,
                  data: imageBytes.toString("base64"),
                },
              },
              { text: prompt },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0,
        },
      }),
    },
  );

  const payload = await scannerResponse.json();

  if (!scannerResponse.ok) {
    return Response.json(
      { error: payload?.error?.message ?? "Receipt scan failed." },
      { status: scannerResponse.status },
    );
  }

  const text = payload?.candidates?.[0]?.content?.parts
    ?.map((part: { text?: string }) => part.text ?? "")
    .join("")
    .trim();

  if (!text) {
    return Response.json({ error: "The receipt scanner returned no bill data." }, { status: 502 });
  }

  try {
    return Response.json({
      bill: normalizeParsedBill(JSON.parse(stripJsonFences(text))),
    });
  } catch {
    return Response.json(
      { error: "The receipt scanner returned malformed bill data." },
      { status: 502 },
    );
  }
}

function stripJsonFences(value: string) {
  return value.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "");
}
