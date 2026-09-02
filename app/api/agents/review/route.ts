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
import type { BillPreimage } from "@/lib/bill-metadata";
import { getOrCreateWallet } from "@/lib/wallet-provider";
import { PRICES } from "@/lib/x402/pricing";
import { withGateway } from "@/lib/x402/seller";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ENDPOINT = "/api/agents/review";

// Narrowed rather than cast. `typeof preimage === "object"` admits {} and [], and
// on those the prompt reads undefined merchant/total and calls .join on nothing —
// which only fails closed because reviewBill wraps prompt construction in a try.
// Leaning on the callee's defensiveness for this route's own input validation is
// how a later refactor there turns into an approval here.
//
// Checks exactly the four fields the prompt reads. receiptHash and dueDate are
// deliberately not required: this endpoint judges plausibility and never verifies
// a metadataHash, so demanding them would reject callers for fields it ignores —
// hence Omit rather than a BillPreimage predicate that would be claiming more
// than it checked.
type ReviewablePreimage = Omit<BillPreimage, "receiptHash">;

function isPreimageShaped(value: unknown): value is ReviewablePreimage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.merchant === "string" &&
    typeof p.currency === "string" &&
    typeof p.total === "number" &&
    Number.isFinite(p.total) &&
    Array.isArray(p.participantLabels) &&
    p.participantLabels.every((label) => typeof label === "string")
  );
}

// Resolved once per process, the same lazy pattern the validator and registrar
// already use. Distinct from the Settler and from every user's agent, so the
// three roles on a job are three different addresses and nobody grades their
// own work.
// ponytail: cached for the process's lifetime, so re-pointing the Auditor at a different wallet needs a restart; read it per request if the address ever has to move live.
let auditorAddress: Promise<string | null> | null = null;

function getAuditorAddress(): Promise<string | null> {
  auditorAddress ??= getOrCreateWallet("splitsy", "auditor")
    .then((wallet) => {
      // An unconfigured backend returns null WITHOUT throwing (the circle stack's
      // getConfig, in lib/circle-dcw.ts), so this must throw to reach the catch
      // below. Resolving the cached promise to null instead would pin the failure
      // for the process's whole life: every later request would 500 in silence,
      // and repairing the credentials would not fix it because nothing would
      // re-ask Circle.
      if (!wallet) throw new Error("Circle is not configured; no Auditor wallet to be paid at");
      return wallet.address;
    })
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
  // below go straight into a prompt that decides whether money moves. Each field
  // is REJECTED when absent rather than coerced, because Number(null) and
  // Number("") are both 0 and 0 is the most approvable value in the input
  // domain — lib/autopay-review.ts's prompt refuses a share that is too HIGH and
  // is told explicitly not to refuse a low one, so a coerced-to-zero share would
  // come back a confident approval for a number the Auditor never saw.
  const preimage = body?.preimage;
  if (!isPreimageShaped(preimage)) {
    return Response.json({ error: "Expected { preimage, shareUsdc, participantCount, creatorScore }." }, { status: 400 });
  }
  const shareUsdc = typeof body?.shareUsdc === "number" ? body.shareUsdc : NaN;
  const participantCount = typeof body?.participantCount === "number" ? body.participantCount : NaN;
  if (!Number.isFinite(shareUsdc) || shareUsdc < 0) {
    return Response.json({ error: "shareUsdc must be a non-negative number." }, { status: 400 });
  }
  if (!Number.isInteger(participantCount) || participantCount < 1) {
    return Response.json({ error: "participantCount must be a whole number of at least 1." }, { status: 400 });
  }
  const rawScore = body?.creatorScore;
  const creatorScore =
    rawScore === null || rawScore === undefined ? null : typeof rawScore === "number" ? rawScore : NaN;
  if (creatorScore !== null && !Number.isFinite(creatorScore)) {
    return Response.json({ error: "creatorScore must be a number or null." }, { status: 400 });
  }

  // A 400 keeps the $0.002: the wrapper verifies and settles before the handler
  // is ever called (lib/x402/seller.ts), so by here the money has moved and
  // cannot be un-moved. Deliberate — refunding would mean restructuring the
  // handshake for every seller — and it is the buyer's own malformed request. It
  // does NOT enter the earnings ledger, because that is gated on a 2xx.
  //
  // reviewBill never throws — every path returns a verdict, and an
  // unreachable model is a refusal. That contract is what lets the buyer treat
  // a 200 as an answer and anything else as "no review happened".
  // receiptHash is supplied empty rather than taken from the caller: ReviewInput
  // demands a full BillPreimage, but reviewBill's prompt never reads this field —
  // it judges plausibility and verifies no metadataHash. Filling it here, instead
  // of widening ReviewInput (lib/autopay-review.ts is not this task's to change)
  // or casting, keeps isPreimageShaped honest about the four fields it did check.
  const verdict = await reviewBill({
    preimage: { ...preimage, receiptHash: "" },
    shareUsdc,
    participantCount,
    creatorScore,
  });
  return Response.json(verdict);
}

export const POST = withGateway(handler, PRICES[ENDPOINT], ENDPOINT, getAuditorAddress);
