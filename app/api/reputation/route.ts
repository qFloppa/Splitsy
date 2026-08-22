import { reputationResponse } from "@/lib/reputation-lookup";
import { PRICES } from "@/lib/x402/pricing";
import { withGateway } from "@/lib/x402/seller";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ENDPOINT = "/api/reputation";

// The reputation aggregate sold as a paid service at $0.001. Any agent — a DeFi
// app, another expense splitter, a counterparty-risk evaluator — can buy a
// verdict without needing a Splitsy account.
//
// The answer itself is built in lib/reputation-lookup; what this route adds is
// the price and the x402 handshake. Splitsy's own UI reads the same answer
// unpaid at /api/reputation/lookup — see the note there.
export const GET = withGateway(reputationResponse, PRICES[ENDPOINT], ENDPOINT);
