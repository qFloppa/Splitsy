import { parseReceipt } from "@/lib/ocr-core";

export const runtime = "nodejs";

const MAX_INLINE_BYTES = 12 * 1024 * 1024;

export async function POST(request: Request) {
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

  try {
    const imageBase64 = Buffer.from(await file.arrayBuffer()).toString("base64");
    return Response.json({ bill: await parseReceipt(imageBase64, file.type) });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Receipt scan failed." },
      { status: 502 },
    );
  }
}
