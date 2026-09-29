import { after } from "next/server";
import { runScout } from "@/lib/scout/scan";
import { buildScoutDeps, scoutBaseUrl, DAILY_CAP_USD } from "@/lib/scout/deps";
import { ensureGatewayBalance } from "@/lib/scout/wallet";
import { parseReceipt } from "@/lib/ocr-core";
import { imageSize } from "@/lib/image-size";
import { remainingBudget } from "@/lib/x402/spend";
import { callerIp, checkScanIpLimit, SCAN_MAX_PER_IP } from "@/lib/rate-limit";
import { verifyTurnstile } from "@/lib/turnstile";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

const MAX_INLINE_BYTES = 12 * 1024 * 1024;

// The human upload path. A browser posts the photo here; Scout assesses it, pays
// Splitsy's own x402 endpoints on the user's behalf, and returns the split plus a
// receipt of what it spent. The browser never handles a 402 or holds a key.
//
// WHY THIS IS GATED AT ALL, given it takes no money from the caller. Every scan
// reaches a paid model. Scout's x402 spend is capped by SCOUT_DAILY_CAP_USDC, but
// past that cap runScout degrades to `parseDirect` — a DIRECT call on
// RECEIPT_SCANNER_API_KEY with no cap of its own (lib/scout/scan.ts:129) — and on
// Arc mainnet x402 batching is unavailable at all (docs/deployments.md), so
// `buildScoutDeps` throws and the unpaid fallback below is the ONLY path. Ungated,
// this is therefore an open door onto our own model spend, 12 MB at a time.
//
// THE ENDPOINT STAYS ANONYMOUS on purpose: it is what the landing page offers a
// visitor who has not signed in, and requiring a session would cost that. So the
// gate is a challenge plus a per-address ceiling rather than an identity.
//
// A SESSION SUBSTITUTES FOR THE CHALLENGE, and that is not a loosening — a signed
// -in caller is strictly stronger evidence of a person than a captcha is. It is
// also load-bearing: app/BillVerification.tsx calls this from the debtor-side
// receipt audit, which runs on page view with no gesture behind it and so has no
// widget to get a token from. The per-address ceiling below applies either way,
// because the ceiling is the part that bounds spend.
export async function POST(request: Request) {
  const ip = callerIp(request);

  const formData = await request.formData();
  const file = formData.get("image");

  // Counted for EVERY caller, before the shape checks below and whether or not
  // the scan then succeeds: the ceiling is on model calls attempted from an
  // address, and counting only the successful ones would let a stream of
  // deliberate rejects probe for free.
  if (!(await checkScanIpLimit(ip))) {
    return Response.json(
      { error: `That's ${SCAN_MAX_PER_IP} scans from your network today. Try again tomorrow.` },
      { status: 429 },
    );
  }

  if (!(await getSessionUser())) {
    // The challenge travels in the FORM rather than a header because formData()
    // has already streamed the upload by this point — so the cheapest saving left
    // is to refuse before the base64 copy and the model call. A caller who fails
    // here has cost us bandwidth and nothing else.
    const turnstileToken = String(formData.get("turnstileToken") ?? "");
    if (!(await verifyTurnstile(turnstileToken, ip))) {
      return Response.json({ error: "Verification failed. Please try again." }, { status: 400 });
    }
  }

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

  // Top up after responding, not before: a getBalances() round-trip costs ~1s on
  // every scan to guard against a balance that is almost always fine. Running it
  // behind the response means the *next* scan benefits, and a genuinely empty
  // balance still degrades gracefully via the unpaid fallback.
  after(() => ensureGatewayBalance().catch(() => {}));

  const result = await runScout(
    {
      imageBase64,
      mimeType,
      bytes: file.size,
      width: dimensions.width,
      height: dimensions.height,
      skipFx: true, // the browser buys FX separately so the bill can render first
    },
    deps,
  );

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
