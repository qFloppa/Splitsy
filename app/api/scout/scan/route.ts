import { runScout } from "@/lib/scout/scan";
import { buildScoutDeps, scoutBaseUrl, DAILY_CAP_USD } from "@/lib/scout/deps";
import { ensureGatewayBalance } from "@/lib/scout/wallet";
import { parseReceipt } from "@/lib/ocr-core";
import { imageSize } from "@/lib/image-size";
import { remainingBudget } from "@/lib/x402/spend";

export const runtime = "nodejs";

const MAX_INLINE_BYTES = 12 * 1024 * 1024;

// The human upload path. A browser posts the photo here; Scout assesses it, pays
// Splitsy's own x402 endpoints on the user's behalf, and returns the split plus a
// receipt of what it spent. The browser never handles a 402 or holds a key.
export async function POST(request: Request) {
  const formData = await request.formData();
  const file = formData.get("image");

  if (!(file instanceof File) || !file.type.startsWith("image/")) {
    return Response.json({ error: "Upload a bill image." }, { status: 400 });
  }
  if (file.size > MAX_INLINE_BYTES) {
    return Response.json({ error: "Image is too large for inline OCR. Use a smaller photo." }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const imageBase64 = buffer.toString("base64");
  const mimeType = file.type;

  // Unknown format (imageSize returns null) must not fail the quality gate on
  // dimensions it cannot see — only the byte-size floor applies then.
  const dimensions = imageSize(buffer) ?? { width: Number.MAX_SAFE_INTEGER, height: Number.MAX_SAFE_INTEGER };

  let deps: ReturnType<typeof buildScoutDeps>;
  try {
    deps = buildScoutDeps(scoutBaseUrl(request));
  } catch {
    // No Scout key configured at all — still serve the human, unpaid.
    return unpaidFallback(imageBase64, mimeType);
  }

  await ensureGatewayBalance().catch(() => {}); // best-effort top-up

  const result = await runScout({ imageBase64, mimeType, bytes: file.size, width: dimensions.width, height: dimensions.height }, deps);

  return Response.json({
    ...result,
    agent: { address: deps.address, tokenId: process.env.SCOUT_ERC8004_TOKEN_ID ?? null },
  });
}

async function unpaidFallback(imageBase64: string, mimeType: string) {
  try {
    const bill = await parseReceipt(imageBase64, mimeType);
    return Response.json({
      bill,
      payments: [],
      totalSpentUsd: 0,
      budgetRemainingUsd: remainingBudget(0, DAILY_CAP_USD),
      degraded: true,
      agent: null,
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Receipt scan failed." },
      { status: 502 },
    );
  }
}
