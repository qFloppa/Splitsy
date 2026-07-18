import { getSessionUser } from "@/lib/session";
import { resolveParticipants } from "@/lib/wallet-resolve";
import { encodeCreateTab } from "@/lib/registry-calldata";
import { executeContractOnArc, InsufficientFundsError } from "@/lib/circle-dcw";
import {
  RECURRING_TAB_FACTORY_ADDRESS,
  getNextTabIdOnchain,
  findCreatedTab,
} from "@/lib/recurring-read";
import type { IdentityProvider } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROVIDERS: IdentityProvider[] = ["x", "discord", "email"];
const MAX_MEMBERS = 20;
const toUnits = (usd: number) => BigInt(Math.round(usd * 1e6));

type InRow = { provider?: unknown; handle?: unknown; address?: unknown; shareUsd?: unknown };

// Social creator path for recurring tabs: the signed-in user's Circle DCW signs
// createTab and becomes the tab's recipient. Members can be raw 0x addresses or
// social handles (resolved — pre-minting a DCW when needed), the same mix the
// one-off bills create route accepts.
export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  if (!user.circle_wallet_id || !user.wallet_address) {
    return Response.json({ error: "Your wallet isn't provisioned yet. Log in again." }, { status: 409 });
  }

  const body = (await request.json().catch(() => null)) as {
    intervalSeconds?: unknown;
    maxSettlements?: unknown;
    members?: InRow[];
  } | null;
  if (!body || !Array.isArray(body.members) || body.members.length === 0) {
    return Response.json({ error: "members required" }, { status: 400 });
  }

  const intervalSeconds =
    typeof body.intervalSeconds === "number" && Number.isInteger(body.intervalSeconds) ? body.intervalSeconds : NaN;
  if (!Number.isFinite(intervalSeconds) || intervalSeconds < 1) {
    return Response.json({ error: "invalid intervalSeconds" }, { status: 400 });
  }
  const maxSettlements =
    typeof body.maxSettlements === "number" && Number.isInteger(body.maxSettlements) ? body.maxSettlements : NaN;
  if (!Number.isFinite(maxSettlements) || maxSettlements < 1) {
    return Response.json({ error: "invalid maxSettlements" }, { status: 400 });
  }

  const recipient = user.wallet_address as `0x${string}`;
  const recipientLower = recipient.toLowerCase();

  // Split rows into social (need resolving) and raw-address, remembering order.
  const socialRows: { provider: IdentityProvider; handle: string }[] = [];
  const slots: ({ kind: "social"; idx: number; share: bigint } |
                { kind: "address"; address: `0x${string}`; share: bigint })[] = [];
  for (const r of body.members) {
    const shareUsd = typeof r.shareUsd === "number" ? r.shareUsd : NaN;
    if (!Number.isFinite(shareUsd) || shareUsd <= 0) {
      return Response.json({ error: "each member needs a positive per-cycle share" }, { status: 400 });
    }
    const share = toUnits(shareUsd);
    if (share <= 0n) {
      return Response.json({ error: "each member needs a positive per-cycle share" }, { status: 400 });
    }
    if (typeof r.address === "string" && /^0x[a-fA-F0-9]{40}$/.test(r.address)) {
      slots.push({ kind: "address", address: r.address as `0x${string}`, share });
    } else if (typeof r.provider === "string" && PROVIDERS.includes(r.provider as IdentityProvider) && typeof r.handle === "string") {
      const norm = r.handle.replace(/^@/, "").toLowerCase();
      socialRows.push({ provider: r.provider as IdentityProvider, handle: norm });
      slots.push({ kind: "social", idx: socialRows.length - 1, share });
    } else {
      return Response.json({ error: "each member needs an address or provider+handle" }, { status: 400 });
    }
  }
  if (slots.length === 0 || slots.length > MAX_MEMBERS) {
    return Response.json({ error: "between 1 and 20 members required" }, { status: 400 });
  }

  let resolvedSocial;
  try {
    resolvedSocial = await resolveParticipants(socialRows);
  } catch (err) {
    const message = err instanceof Error ? err.message : "resolve failed";
    return Response.json({ error: message }, { status: /not configured/i.test(message) ? 503 : 500 });
  }

  const members: `0x${string}`[] = [];
  const fixedShares: bigint[] = [];
  for (const s of slots) {
    members.push(s.kind === "address" ? s.address : (resolvedSocial[s.idx].address as `0x${string}`));
    fixedShares.push(s.share);
  }

  // The RecurringTab constructor rejects a member address it sees twice, and the
  // creator can't be a member of their own tab (recipient pulling from itself).
  const seen = new Set<string>();
  for (const m of members) {
    const lower = m.toLowerCase();
    if (lower === recipientLower) {
      return Response.json({ error: "You can't add your own wallet as a member of your recurring tab." }, { status: 400 });
    }
    if (seen.has(lower)) {
      return Response.json({ error: "Each member wallet must be unique." }, { status: 400 });
    }
    seen.add(lower);
  }

  // Snapshot nextTabId before the write so findCreatedTab can bound its fallback
  // scan to ids minted by this call.
  let beforeNextTabId: bigint;
  try {
    beforeNextTabId = await getNextTabIdOnchain();
  } catch {
    beforeNextTabId = 1n;
  }

  let txHash: string | null = null;
  try {
    const tx = await executeContractOnArc(
      user.circle_wallet_id,
      RECURRING_TAB_FACTORY_ADDRESS,
      encodeCreateTab(recipient, BigInt(intervalSeconds), BigInt(maxSettlements), members, fixedShares),
    );
    txHash = tx.txHash;
  } catch (err) {
    if (err instanceof InsufficientFundsError) return Response.json({ error: "insufficient_funds" }, { status: 402 });
    return Response.json({ error: err instanceof Error ? err.message : "createTab failed" }, { status: 502 });
  }

  const created = await findCreatedTab(txHash, beforeNextTabId, recipient).catch(() => null);
  if (!created) {
    return Response.json(
      { error: "Tab created, but its address could not be confirmed. Refresh to see it." },
      { status: 202 },
    );
  }

  return Response.json({ tabId: created.tabId.toString(), tabAddress: created.tabAddress });
}
