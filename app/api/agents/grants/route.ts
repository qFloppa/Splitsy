// The user's own CRUD over their autopay rules, plus a read of the agent's
// decision log. Session-scoped: a grant is a standing permission to spend this
// user's money, so it is only ever readable or writable by that user.
//
// The wallet-unlock cookie is deliberately NOT required here. Editing a rule
// moves no money — the rule is what constrains a later movement — and gating
// the settings page behind an unlock would push people to leave the caps wide
// open rather than tighten them.
import { getSessionUser } from "@/lib/session";
import { getAutopayGrant, listAutopayLog, upsertAutopayGrant } from "@/lib/agents-repo";
import type { AutopayGrant } from "@/lib/autopay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Nothing is enabled by default, and both caps start at zero. A blank row must
// never read as "unlimited" — see the note in schema-agents.sql.
const DEFAULT_GRANT: AutopayGrant = {
  enabled: false,
  maxPerBillUsdc: 0,
  maxPerDayUsdc: 0,
  trustedCreators: [],
  minCreatorScore: 0,
  requireVerifiedHash: true,
};

export async function GET() {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });

  const [grant, log] = await Promise.all([getAutopayGrant(user.id), listAutopayLog(user.id)]);

  // The user id is already the session's; echoing it back would only invite a
  // client to send a different one.
  const rules: AutopayGrant = grant
    ? {
        enabled: grant.enabled,
        maxPerBillUsdc: grant.maxPerBillUsdc,
        maxPerDayUsdc: grant.maxPerDayUsdc,
        trustedCreators: grant.trustedCreators,
        minCreatorScore: grant.minCreatorScore,
        requireVerifiedHash: grant.requireVerifiedHash,
      }
    : DEFAULT_GRANT;

  return Response.json({ grant: rules, log });
}

export async function PUT(request: Request) {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });

  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const raw = body as Record<string, unknown>;

  // Caps are money, so they are validated at this trust boundary rather than
  // trusted from the client: a NaN or a negative would otherwise land in the
  // DB and be compared against a real amount later.
  const maxPerBillUsdc = toMoney(raw.maxPerBillUsdc);
  const maxPerDayUsdc = toMoney(raw.maxPerDayUsdc);
  if (maxPerBillUsdc === null || maxPerDayUsdc === null) {
    return Response.json({ error: "Caps must be non-negative numbers." }, { status: 400 });
  }

  const minCreatorScore = Number(raw.minCreatorScore ?? 0);
  if (!Number.isInteger(minCreatorScore) || minCreatorScore < 0 || minCreatorScore > 100) {
    return Response.json({ error: "The score floor must be a whole number from 0 to 100." }, { status: 400 });
  }

  const trustedCreators = Array.isArray(raw.trustedCreators)
    ? raw.trustedCreators.map((a) => String(a).trim().toLowerCase()).filter(Boolean)
    : [];
  if (trustedCreators.some((a) => !/^0x[a-f0-9]{40}$/.test(a))) {
    return Response.json({ error: "Trusted creators must be 0x wallet addresses." }, { status: 400 });
  }

  await upsertAutopayGrant({
    userId: user.id,
    enabled: raw.enabled === true,
    maxPerBillUsdc,
    maxPerDayUsdc,
    trustedCreators,
    minCreatorScore,
    // Default ON: the verified-hash check is what stops the agent paying a bill
    // whose details it cannot confirm, so turning it off must be deliberate.
    requireVerifiedHash: raw.requireVerifiedHash !== false,
  });

  return Response.json({ ok: true });
}

function toMoney(value: unknown): number | null {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
