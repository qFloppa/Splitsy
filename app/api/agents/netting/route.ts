// Debt-netting solver as a paid service: given a set of members and charges,
// returns the minimal-transfer settlement plan plus the positions that underlie
// it. Wraps lib/netting.ts — the same algorithm Splitsy's own UI uses — as a
// public x402 endpoint so any agent or group can buy an optimised plan without
// running the solver themselves.
//
// The solver is pure computation: it never reads Splitsy's database or Arc.
// Every member ID and charge is caller-supplied. Members only need an `id`
// field; all other fields in lib/types.ts Member are internal to Splitsy and
// are ignored here.
//
// BigInts in the response are serialised as decimal strings (`amountMicros`)
// because JSON cannot represent them, plus a human-readable USDC string
// (`amountUsdc`) so callers don't have to do the division themselves.
import {
  computeNetPositions,
  computeMinimumTransfers,
  computeNaiveTransactionCount,
  formatUsdcFromMicros,
} from "@/lib/netting";
import type { Charge, Member } from "@/lib/types";
import { PRICES } from "@/lib/x402/pricing";
import { withGateway } from "@/lib/x402/seller";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ENDPOINT = "/api/agents/netting";

// What the endpoint actually needs from a member: just the id.
// lib/types.ts Member has many Splitsy-internal fields the solver never reads.
type SlimMember = { id: string };

// What the endpoint needs from a charge: matches the lib/types.ts Charge shape
// so callers using Splitsy data can pass it through unchanged.
type SlimCharge = {
  id: string;
  paid_by_member_id: string;
  amount_usdc: string;
  split_among: string[];
};

function isMemberArray(value: unknown): value is SlimMember[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((m) => m && typeof m === "object" && typeof (m as Record<string, unknown>).id === "string")
  );
}

function isChargeArray(value: unknown): value is SlimCharge[] {
  return (
    Array.isArray(value) &&
    value.every((c) => {
      if (!c || typeof c !== "object") return false;
      const r = c as Record<string, unknown>;
      return (
        typeof r.id === "string" &&
        typeof r.paid_by_member_id === "string" &&
        typeof r.amount_usdc === "string" &&
        Array.isArray(r.split_among) &&
        (r.split_among as unknown[]).every((s) => typeof s === "string")
      );
    })
  );
}

async function handler(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    members?: unknown;
    charges?: unknown;
  } | null;

  if (!body) {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  if (!isMemberArray(body.members)) {
    return Response.json(
      { error: "members must be a non-empty array of { id: string }." },
      { status: 400 },
    );
  }
  if (!isChargeArray(body.charges)) {
    return Response.json(
      { error: "charges must be an array of { id, paid_by_member_id, amount_usdc, split_among }." },
      { status: 400 },
    );
  }

  // Fill in the Splitsy-internal fields the solver never reads. Keeping the
  // route's own input lean (only `id`) and adapting at the boundary stops
  // callers having to know Splitsy's DB schema.
  const fullMembers: Member[] = body.members.map((m) => ({
    id: m.id,
    tab_id: "",
    display_name: m.id,
    evm_address: "",
    arc_recipient_address: "",
    created_at: "",
  }));

  const fullCharges: Charge[] = body.charges.map((c) => ({
    ...c,
    tab_id: "",
    description: "",
    created_at: "",
  }));

  let positions: ReturnType<typeof computeNetPositions>;
  try {
    positions = computeNetPositions(fullMembers, fullCharges);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Invalid members or charges." },
      { status: 400 },
    );
  }

  const transfers = computeMinimumTransfers(positions);
  const naiveTransactionCount = computeNaiveTransactionCount(fullCharges);

  return Response.json({
    // Net position per member. Positive = net creditor (paid more than owed),
    // negative = net debtor. The sign is for human orientation only — the
    // transfers array already encodes who pays whom.
    positions: positions.map((p) => ({
      memberId: p.memberId,
      // Decimal string to survive JSON safely.
      amountMicros: p.amountMicros.toString(),
      // Formatted USDC with sign, e.g. "-3.50" or "7.00".
      amountUsdc: formatUsdcFromMicros(p.amountMicros),
    })),
    transfers: transfers.map((t) => ({
      fromMemberId: t.fromMemberId,
      toMemberId: t.toMemberId,
      amountMicros: t.amountMicros.toString(),
      amountUsdc: formatUsdcFromMicros(t.amountMicros),
    })),
    // How many transfers a naive "everyone settles their own charge" would need.
    naiveTransactionCount,
    // How many the solver reduced it to.
    nettedTransactionCount: transfers.length,
  });
}

export const POST = withGateway(handler, PRICES[ENDPOINT], ENDPOINT);
