import { parseReceipt } from "@/lib/ocr-core";
import { withGateway } from "@/lib/x402/seller";
import { PRICES } from "@/lib/x402/pricing";

export const runtime = "nodejs";

// x402-paywalled: buyers (Scout, or any external agent) pay $0.005 USDC per
// scan. Human uploads reach this through /api/scout/scan, which pays on their
// behalf — the browser never sees the 402.
const handler = async (request: Request): Promise<Response> => {
  const { imageBase64, mimeType, hq } = (await request.json()) as {
    imageBase64?: string;
    mimeType?: string;
    hq?: boolean;
  };

  if (!imageBase64 || !mimeType) {
    return Response.json({ error: "imageBase64 and mimeType are required." }, { status: 400 });
  }
  if (!mimeType.startsWith("image/")) {
    return Response.json({ error: "mimeType must be an image type." }, { status: 400 });
  }

  try {
    return Response.json({ bill: await parseReceipt(imageBase64, mimeType, { hq }) });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Receipt scan failed." },
      { status: 502 },
    );
  }
};

export const POST = withGateway(handler, PRICES["/api/ocr"], "/api/ocr");
