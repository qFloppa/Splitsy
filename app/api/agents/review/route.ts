// The Splitsy Auditor's paid bill review, and the evaluator's day job.
//
// lib/autopay-review.ts used to be a free internal function call. Making it a
// paid endpoint is what turns "an agent with a model prompt" into two agents
// that trade: the Settler buys this verdict for $0.002 out of the fee income it
// has accumulated, and the Auditor earns it. Both sides land in x402_payments —
// 'earned' by the seller wrapper here, 'spent' by the Settler.
//
// PUBLIC to anyone who pays, like /api/ocr and /api/fx, and that is the point:
// it is a service the Auditor sells. It leaks nothing — every field it judges
// arrives in the request body, so a stranger who pays $0.002 gets a verdict on
// their own data and learns nothing about Splitsy's.
//
// reviewBill() itself is not rewritten. This is a thin wrapper: the same input,
// the same verdict shape, and the same fail-closed behaviour.
import { reviewBill } from "@/lib/autopay-review";
import { getOrCreateArcWallet } from "@/lib/circle-dcw";
import { PRICES } from "@/lib/x402/pricing";
import { withGateway } from "@/lib/x402/seller";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ENDPOINT = "/api/agents/review";

// Resolved once per process, the same lazy pattern the validator and registrar
// already use. Distinct from the Settler and from every user's agent, so the
// three roles on a job are three different addresses and nobody grades their
// own work.
let auditorAddress: Promise<string | null> | null = null;

function getAuditorAddress(): Promise<string | null> {
  auditorAddress ??= getOrCreateArcWallet("splitsy", "auditor")
    .then((wallet) => wallet?.address ?? null)
    .catch((err) => {
      console.error("[review] could not resolve the Auditor wallet:", err);
      auditorAddress = null; // let the next request retry
      return null;
    });
  return auditorAddress;
}

async function handler(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    preimage?: unknown;
    shareUsdc?: unknown;
    participantCount?: unknown;
    creatorScore?: unknown;
  } | null;

  // Validated at the trust boundary: this endpoint is public and the numbers
  // below go straight into a prompt that decides whether money moves.
  const preimage = body?.preimage;
  const shareUsdc = Number(body?.shareUsdc);
  const participantCount = Number(body?.participantCount);
  if (!preimage || typeof preimage !== "object") {
    return Response.json({ error: "Expected { preimage, shareUsdc, participantCount, creatorScore }." }, { status: 400 });
  }
  if (!Number.isFinite(shareUsdc) || shareUsdc < 0) {
    return Response.json({ error: "shareUsdc must be a non-negative number." }, { status: 400 });
  }
  if (!Number.isInteger(participantCount) || participantCount < 1) {
    return Response.json({ error: "participantCount must be a whole number of at least 1." }, { status: 400 });
  }
  const rawScore = body?.creatorScore;
  const creatorScore = rawScore === null || rawScore === undefined ? null : Number(rawScore);
  if (creatorScore !== null && !Number.isFinite(creatorScore)) {
    return Response.json({ error: "creatorScore must be a number or null." }, { status: 400 });
  }

  // reviewBill never throws — every path returns a verdict, and an
  // unreachable model is a refusal. That contract is what lets the buyer treat
  // a 200 as an answer and anything else as "no review happened".
  const verdict = await reviewBill({
    preimage: preimage as Parameters<typeof reviewBill>[0]["preimage"],
    shareUsdc,
    participantCount,
    creatorScore,
  });
  return Response.json(verdict);
}

export const POST = withGateway(handler, PRICES[ENDPOINT], ENDPOINT, getAuditorAddress);
