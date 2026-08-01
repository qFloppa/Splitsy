// The user's own CRUD over their autopay rules, plus a read of the agent's
// decision log. Session-scoped: a grant is a standing permission to spend this
// user's money, so it is only ever readable or writable by that user.
//
// The rules are split across two stores, and the split is the whole design:
//
//   * The CAPS and the creator allowlist live in AutopayMandate.sol. They are
//     the numbers that decide whether money moves, so they are held by the thing
//     that can actually stop it. Postgres keeps a mirror for display only.
//   * The SCORE FLOOR and the verified-hash check live in Postgres, because the
//     chain cannot evaluate either: ERC-8004 stores individual feedback rather
//     than the aggregate, and no contract can see the off-chain preimage. Both
//     fail closed in the agent's pre-flight.
//
// So a PUT writes Postgres always, and writes the chain only when the on-chain
// half actually changed — the settings panel saves on blur, and a transaction
// per blur would be absurd. The chain write is one batch from the user's own
// wallet: approve, then setMandate. Half of that pair landing alone would leave
// either a standing allowance with no mandate to bound it, or a mandate that
// cannot pull.
//
// The wallet-unlock cookie is deliberately NOT required here. Gating the
// settings page behind an unlock would push people to leave the caps wide open
// rather than tighten them, and TIGHTENING must never be harder than loosening.
import { getSessionUser } from "@/lib/session";
import { getAutopayGrant, listAutopayLog, upsertAutopayGrant } from "@/lib/agents-repo";
import type { AutopayGrant } from "@/lib/autopay";
import {
  getAutopayMandateOnchain,
  getUsdcAllowanceOnchain,
  isMandateConfigured,
  MANDATE_ADDRESS,
} from "@/lib/arc-read";
import { executeContractOnArc, getOrCreateArcWallet, InsufficientFundsError } from "@/lib/circle-dcw";
import { encodeApprove, encodeExecuteBatch, encodeRevokeMandate, encodeSetMandate } from "@/lib/registry-calldata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ARC_USDC_ADDRESS = (process.env.ARC_TESTNET_USDC_ADDRESS ??
  "0x3600000000000000000000000000000000000000") as `0x${string}`;

// The contract's own bound on the creator allowlist. Rejected here too so the
// user gets a sentence instead of a revert.
const MAX_ALLOWED_CREATORS = 10;

// Total exposure the approval permits, derived from the daily cap rather than
// asked for as a third number nobody wants to reason about. A week of spending
// at the full ceiling, after which the next Save tops it back up.
const APPROVAL_DAYS = 7n;

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

const units = (usdc: number) => BigInt(Math.round(usdc * 1_000_000));
const toUsdc = (units: bigint) => Number(units) / 1_000_000;

export async function GET() {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });

  const rules = await getAutopayGrant(user.id);
  const dcw = user.wallet_address ? (user.wallet_address.toLowerCase() as `0x${string}`) : null;
  const eoa = rules?.debtorAddress ? (rules.debtorAddress as `0x${string}`) : null;

  // Read both wallets in one pass. A person can have the Splitsy wallet armed
  // for one agent and their browser wallet armed for another, with different
  // ceilings — the mandate is keyed per debtor on chain, so the panel must be
  // able to show two answers rather than implying one setting binds both.
  //
  // The `onchain` map below is keyed by LOWERCASE address. A browser wallet
  // hands you a checksummed one, so lowercase before indexing it or you get
  // undefined — and with noUncheckedIndexedAccess off, tsc will not say so.
  const wallets = [dcw, eoa].filter((a): a is `0x${string}` => a !== null);
  const [log, ...facts] = await Promise.all([
    listAutopayLog(user.id),
    ...wallets.map(async (address) => {
      const [mandate, allowance] = await Promise.all([
        getAutopayMandateOnchain(address).catch(() => null),
        isMandateConfigured()
          ? getUsdcAllowanceOnchain(address, MANDATE_ADDRESS).catch(() => 0n)
          : Promise.resolve(0n),
      ]);
      return [
        address,
        {
          agentAddress: mandate?.agent ?? null,
          enabled: mandate !== null,
          maxPerBillUsdc: mandate ? toUsdc(mandate.maxPerBill) : 0,
          maxPerDayUsdc: mandate ? toUsdc(mandate.maxPerDay) : 0,
          trustedCreators: mandate ? mandate.allowedCreators.map((a) => a.toLowerCase()) : [],
          allowanceUsdc: toUsdc(allowance ?? 0n),
          spentTodayUsdc: mandate ? toUsdc(mandate.maxPerDay - mandate.headroom) : 0,
        },
      ] as const;
    }),
  ]);

  const onchain = Object.fromEntries(facts);
  const dcwFacts = dcw ? onchain[dcw] : null;

  // The form's own values still come from the DCW's mandate when there is one,
  // falling back to the Postgres mirror so a user sees the numbers they typed
  // but have not yet signed. `enabled` is never mirrored: it is the answer to
  // "can software move my money right now?" and must come from the chain alone.
  const grant: AutopayGrant & { requireBillReview: boolean } = {
    enabled: dcwFacts?.enabled ?? false,
    maxPerBillUsdc: dcwFacts?.enabled ? dcwFacts.maxPerBillUsdc : (rules?.maxPerBillUsdc ?? DEFAULT_GRANT.maxPerBillUsdc),
    maxPerDayUsdc: dcwFacts?.enabled ? dcwFacts.maxPerDayUsdc : (rules?.maxPerDayUsdc ?? DEFAULT_GRANT.maxPerDayUsdc),
    trustedCreators: dcwFacts?.enabled ? dcwFacts.trustedCreators : (rules?.trustedCreators ?? []),
    minCreatorScore: rules?.minCreatorScore ?? DEFAULT_GRANT.minCreatorScore,
    requireVerifiedHash: rules?.requireVerifiedHash ?? DEFAULT_GRANT.requireVerifiedHash,
    requireBillReview: rules?.requireBillReview ?? true,
  };

  return Response.json({
    grant,
    log,
    linkedAddress: eoa,
    walletAddress: dcw,
    // The panel needs BOTH to rebuild the exact bytes the wallet must sign.
    // buildLinkMessage puts the handle AND the provider inside the message,
    // because a handle alone is not an account: uniqueness in `users` is
    // (provider, provider_user_id), and idx_users_provider_handle is NOT unique.
    // Without the provider, a victim signing a message naming their own handle
    // could have that signature replayed by the holder of the same handle in
    // another namespace. Both are lowercased inside buildLinkMessage.
    handle: user.handle,
    provider: user.provider,
    mandateAddress: isMandateConfigured() ? MANDATE_ADDRESS : null,
    // The SAME resolver the DCW path signs with, not a bare read of the env var.
    // A browser wallet signs its own mandate, so this response is the only place
    // it can learn which agent to name — and reading the env var alone made that
    // null in every deployment that never set one, which is all of them: the
    // agent's wallet is lazily created under a fixed refId, not configured. The
    // DCW path resolved it server-side and worked; the browser path got "" and
    // failed the address check in armOnChain.
    //
    // Lowercased to match `onchain[a].agentAddress`, which viem returns EIP-55
    // checksummed. The panel compares the two to ask "is this mandate pointing at
    // OUR agent?", and a case-sensitive === would answer no for a live Splitsy
    // mandate.
    agentAddress: (await resolveAgentAddress().catch(() => null))?.toLowerCase() ?? null,
    onchain,
  });
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
  if (trustedCreators.length > MAX_ALLOWED_CREATORS) {
    return Response.json(
      { error: `At most ${MAX_ALLOWED_CREATORS} allowed creators. Leave the list empty to allow anyone.` },
      { status: 400 },
    );
  }

  const enabled = raw.enabled === true;

  // Read before write: debtor_address is not in the upsert payload, but the row
  // type requires it, and a settings save must never disturb the link.
  const existing = await getAutopayGrant(user.id);

  await upsertAutopayGrant({
    userId: user.id,
    enabled,
    maxPerBillUsdc,
    maxPerDayUsdc,
    trustedCreators,
    minCreatorScore,
    // Default ON: the verified-hash check is what stops the agent paying a bill
    // whose details it cannot confirm, so turning it off must be deliberate.
    requireVerifiedHash: raw.requireVerifiedHash !== false,
    debtorAddress: existing?.debtorAddress ?? null,
    requireBillReview: raw.requireBillReview !== false,
    // ponytail: preserved, not read from the body yet — the money mode has no UI
    // and no validation here. Task 8 takes it from `raw` at this trust boundary.
    moneyMode: existing?.moneyMode ?? "mandate",
  });

  // A browser wallet signs its own mandate: the server holds no key for it, so
  // there is nothing to sign here and saying so is not an error. The panel
  // follows up with setMandate then approve from the wallet itself.
  const debtorAddress = typeof raw.debtorAddress === "string" ? raw.debtorAddress.toLowerCase() : null;
  if (debtorAddress && debtorAddress === existing?.debtorAddress) {
    return Response.json({ ok: true, txHash: null, signWith: "wallet" });
  }
  // Named a debtor we do not recognise: refuse rather than fall through. Falling
  // through would server-sign a standing mandate on the DCW — arming autopay on
  // a wallet the caller did not select. That is reachable without malice: a
  // browser wallet can switch accounts at any moment, so the panel may hold 0xB
  // while the link row still says 0xA. Skip, never substitute.
  if (debtorAddress) {
    return Response.json(
      { error: "That wallet isn't linked to your account. Link it again, then save." },
      { status: 400 },
    );
  }

  try {
    const txHash = await syncMandateOnchain(user, { enabled, maxPerBillUsdc, maxPerDayUsdc, trustedCreators });
    return Response.json({ ok: true, txHash, signWith: "dcw" });
  } catch (err) {
    if (err instanceof InsufficientFundsError) {
      return Response.json({ error: "insufficient_funds" }, { status: 402 });
    }
    // The off-chain rules SAVED; only the on-chain half failed. Saying so beats
    // a bare 502, because the two halves are now genuinely out of step and the
    // user needs to know which one binds.
    return Response.json(
      {
        error:
          err instanceof Error
            ? `Your rules were saved, but the on-chain mandate did not update: ${err.message}`
            : "Your rules were saved, but the on-chain mandate did not update.",
      },
      { status: 502 },
    );
  }
}

// Writes the chain only when the on-chain half actually differs from what is
// already there. Returns the tx hash, or null when nothing needed signing —
// which is the common case, because the settings panel saves on every blur.
async function syncMandateOnchain(
  user: { circle_wallet_id: string | null; wallet_address: string | null },
  next: { enabled: boolean; maxPerBillUsdc: number; maxPerDayUsdc: number; trustedCreators: string[] },
): Promise<string | null> {
  if (!isMandateConfigured()) return null;
  if (!user.circle_wallet_id || !user.wallet_address) {
    throw new Error("your wallet isn't provisioned yet — log in again");
  }

  const wallet = user.wallet_address as `0x${string}`;
  const current = await getAutopayMandateOnchain(wallet).catch(() => null);

  if (!next.enabled) {
    // Already off. Revoking again is harmless on the contract but would cost a
    // transaction to prove nothing changed.
    if (!current) return null;
    const tx = await executeContractOnArc(user.circle_wallet_id, MANDATE_ADDRESS, encodeRevokeMandate());
    return tx.txHash;
  }

  const agent = await resolveAgentAddress();
  if (!agent) throw new Error("the autopay agent's wallet is unavailable");

  const maxPerBill = units(next.maxPerBillUsdc);
  const maxPerDay = units(next.maxPerDayUsdc);
  const creators = next.trustedCreators.map((a) => a as `0x${string}`);

  const unchanged =
    current !== null &&
    current.agent.toLowerCase() === agent.toLowerCase() &&
    current.maxPerBill === maxPerBill &&
    current.maxPerDay === maxPerDay &&
    current.allowedCreators.length === creators.length &&
    current.allowedCreators.every((a, i) => a.toLowerCase() === creators[i]);
  if (unchanged) return null;

  // approve + setMandate as ONE atomic batch. The approval is the ceiling on
  // total exposure and the mandate is the ceiling on each pull; either one
  // landing without the other is a state the user never asked for. Re-approving
  // on every real change is also the top-up path — an allowance spent down over
  // a week is replenished by the next Save rather than silently running dry.
  const data = encodeExecuteBatch([
    { to: ARC_USDC_ADDRESS, data: encodeApprove(MANDATE_ADDRESS, maxPerDay * APPROVAL_DAYS) },
    { to: MANDATE_ADDRESS, data: encodeSetMandate(agent, maxPerBill, maxPerDay, creators) },
  ]);

  const tx = await executeContractOnArc(user.circle_wallet_id, wallet, data);
  return tx.txHash;
}

// The agent the mandate will name. The env var is the deployment's answer; the
// DCW lookup is the fallback, so a fresh environment works without one more
// address to copy by hand. Same refId the autopay route resolves, so the two
// cannot drift apart.
async function resolveAgentAddress(): Promise<`0x${string}` | null> {
  const configured = process.env.NEXT_PUBLIC_AUTOPAY_AGENT_ADDRESS;
  if (configured && /^0x[a-fA-F0-9]{40}$/.test(configured)) return configured as `0x${string}`;

  const agent = await getOrCreateArcWallet("splitsy", "autopay-agent");
  return (agent?.address as `0x${string}` | undefined) ?? null;
}

function toMoney(value: unknown): number | null {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
