import { reputationResponse } from "@/lib/reputation-lookup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The same aggregate as /api/reputation, unpaid — this is the app's own read, for
// the badge that appears under a payer as you tag them.
//
// Not a hole in the paywall: the reputation mirror is public data (/api/dashboard
// already serves it for any address the caller names, and the browser reads the
// on-chain side directly via viem). What /api/reputation sells an agent is the
// packaged service — a quoted price, a settled Gateway payment, a ledgered
// receipt — not access to a secret. Splitsy paying Splitsy $0.001 to draw its own
// badge would be theatre, and it would put a Gateway round-trip in front of a
// footnote that renders while someone is still typing.
export const GET = reputationResponse;
