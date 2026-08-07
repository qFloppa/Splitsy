// Dunning decision as a paid service: given one unpaid share's facts, returns
// whether a creditor agent should nudge, escalate, collect, or do nothing.
//
// Wraps lib/dunning.ts's decideDunning — the same pure function the daily sweep
// uses. Selling it as an x402 endpoint lets a creditor's own Circle Agent Wallet
// buy a verdict before acting, without having to reimplement the ladder logic or
// read Splitsy's database.
//
// `remaining` and `collectible` arrive as decimal strings because JSON cannot
// represent bigints. The response serialises `amount` the same way, plus an
// `amountUsdc` number for convenience.
import { decideDunning, type DunningAction } from "@/lib/dunning";
import { PRICES } from "@/lib/x402/pricing";
import { withGateway } from "@/lib/x402/seller";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ENDPOINT = "/api/agents/dunning/verdict";

const VALID_ACTIONS = new Set<string>(["none", "nudge", "escalate", "collect"]);

function isActionArray(value: unknown): value is DunningAction[] {
  return Array.isArray(value) && value.every((a) => typeof a === "string" && VALID_ACTIONS.has(a));
}

async function handler(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    dueDate?: unknown;
    remaining?: unknown;
    hasMandate?: unknown;
    collectible?: unknown;
    alreadyLogged?: unknown;
  } | null;

  if (!body) {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  // dueDate: Unix seconds, 0 = no due date.
  const dueDate = typeof body.dueDate === "number" && Number.isInteger(body.dueDate) ? body.dueDate : NaN;
  if (!Number.isFinite(dueDate) || dueDate < 0) {
    return Response.json(
      { error: "dueDate must be a non-negative integer Unix timestamp (seconds)." },
      { status: 400 },
    );
  }

  // remaining / collectible arrive as decimal strings; BigInt() accepts them.
  // A missing or bad string is an error rather than a zero: 0 means "nothing
  // owed" or "nothing collectible" and should be an explicit caller choice.
  let remaining: bigint;
  let collectible: bigint;
  try {
    if (typeof body.remaining !== "string" || !/^\d+$/.test(body.remaining)) {
      throw new Error("remaining must be a decimal-string integer of USDC base units (e.g. \"5000000\" for $5).");
    }
    remaining = BigInt(body.remaining);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Invalid remaining." }, { status: 400 });
  }
  try {
    if (typeof body.collectible !== "string" || !/^\d+$/.test(body.collectible)) {
      throw new Error("collectible must be a decimal-string integer of USDC base units (e.g. \"5000000\" for $5).");
    }
    collectible = BigInt(body.collectible);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Invalid collectible." }, { status: 400 });
  }

  if (typeof body.hasMandate !== "boolean") {
    return Response.json({ error: "hasMandate must be a boolean." }, { status: 400 });
  }

  const alreadyLogged = body.alreadyLogged ?? [];
  if (!isActionArray(alreadyLogged)) {
    return Response.json(
      { error: "alreadyLogged must be an array of \"none\" | \"nudge\" | \"escalate\" | \"collect\"." },
      { status: 400 },
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const decision = decideDunning(
    { dueDate, remaining, hasMandate: body.hasMandate, collectible, alreadyLogged },
    now,
  );

  return Response.json({
    action: decision.action,
    // Decimal string for safe JSON transport; callers can BigInt() it.
    amountMicros: decision.amount.toString(),
    // Convenience USDC float, rounded to 6dp.
    amountUsdc: Number(decision.amount) / 1_000_000,
    reason: decision.reason,
    // The current server time used for the decision, so callers can audit
    // which side of a due date the server fell on.
    evaluatedAt: now,
  });
}

export const POST = withGateway(handler, PRICES[ENDPOINT], ENDPOINT);
