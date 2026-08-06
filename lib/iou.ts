// The IOU: a debt stated as one sentence instead of derived from a receipt.
//
// Two sentences, two rails, and the split is forced by the contract rather than
// chosen. BillSplitRegistry.createBill sets `bill.splitter = msg.sender` and
// `claim` pays only the splitter, so the creditor is ALWAYS the signer:
//
//   "@dani owes me $42"  → I'm the creditor → a 1-participant registry bill.
//   "I owe @dani $42"    → I'm the debtor   → a direct USDC transfer.
//
// The second one cannot be a registry bill. That would need @dani to be the
// splitter, i.e. signing createBill from someone else's wallet.
//
// Pure and framework-free (no "use client", no next/*, no @/ aliases) so it
// stays importable by `node --test`. See lib/settle-items.ts for the same rule.
import type { AccountProvider, IdentityProvider } from "./types.ts";

export type IouDirection = "i-owe" | "owes-me";

// What the composer holds: raw strings, exactly as typed. Validation happens
// once, at commit, in planIou.
export type IouDraft = {
  direction: IouDirection;
  target: string; // the @handle / email / 0x address, as typed
  provider: IdentityProvider; // picked for bare handles; email + address auto-detected
  amount: string;
  note: string;
};

// The resolved intent. `kind` names the rail, so the caller can't accidentally
// send an "i-owe" down the createBill path. `provider` is AccountProvider, not
// IdentityProvider: a raw address is a legitimate target here (it needs no
// namespace lookup — it IS the resolution), so "wallet" reaches the plan.
export type IouPlan =
  | { kind: "ask"; provider: AccountProvider; handle: string; amountUsd: number; note: string }
  | { kind: "settle"; provider: AccountProvider; handle: string; amountUsd: number; note: string };

// The signed-in user, as much of them as the refusals below need. `handle` is
// absent for a wallet-only session; `signerAddress` is the wallet that will
// actually sign this IOU — the only address it is absurd to send one to.
export type IouIdentity = { provider?: string; handle?: string; signerAddress?: string | null } | null;

// One row of the ledger under the composer — the same sentence, small.
export type IouLedgerRow = {
  id: string;
  label: string;
  direction: IouDirection;
  amountUsd: number;
  payBillIds: string[];
};

// A debtor field accepts a 0x address, an email, or a bare X/Discord handle.
// Same two regexes HomeClient's HandleField uses; owned here so the composer,
// the resolve route and the split form can't drift apart.
export const looksLikeAddress = (v: string) => /^0x[a-fA-F0-9]{40}$/.test(v.trim());
export const looksLikeEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

/** Strip a leading "@" and case-fold — the one normalization rule used everywhere. */
export const normalizeHandle = (v: string) => v.trim().replace(/^@/, "").toLowerCase();

/** `0x1234…cdef` — an address, short enough to sit inside a sentence. */
export const shortAddress = (v: string) => `${v.slice(0, 6)}…${v.slice(-4)}`;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

// X caps handles at 15 characters, so 15 is the widest name the sentence was
// ever built to hold — which makes it the budget for everything else too. It
// renders as 16 glyphs once the ellipsis is on. Discord allows 32, so Discord
// is the only handle namespace this can actually fire on.
const COMPACT_HANDLE_MAX = 15;
// An email gets a few more: it is two parts joined by an "@", and clipping it
// to 15 would usually cost the whole domain.
const COMPACT_EMAIL_MAX = 18;

/**
 * The short form of a target, or null when it already fits.
 *
 * The composer sets its subject at up to 7rem, where a 42-character address is
 * three lines of sentence and a work email is two. Only COMPLETE values
 * compact: half an address is still being typed, and re-writing the field
 * mid-keystroke would move the caret out from under whoever is typing.
 */
export function compactTarget(value: string): string | null {
  const v = value.trim();
  if (looksLikeAddress(v)) return shortAddress(v);
  if (looksLikeEmail(v)) {
    if (v.length <= COMPACT_EMAIL_MAX) return null;
    const at = v.lastIndexOf("@");
    // The domain is what identifies an address at a glance ("…@gmail.com"), so
    // it gets first call on the budget and the local part takes what is left.
    // Both halves are elidable, so a 30-character domain can't blow the budget
    // on its own.
    const keepDomain = Math.min(v.length - at - 1, COMPACT_EMAIL_MAX - 5);
    return `${clip(v.slice(0, at), Math.max(3, COMPACT_EMAIL_MAX - keepDomain - 1))}@${clip(v.slice(at + 1), keepDomain)}`;
  }
  // Anything left is a handle (or half of one). An X handle can't reach the
  // budget, so in practice this is Discord's extra 17 characters — and whatever
  // a half-typed email looks like on the way to being one.
  return v.length > COMPACT_HANDLE_MAX ? clip(v, COMPACT_HANDLE_MAX) : null;
}

// Address and email are both detected from the value itself; a bare handle keeps
// whatever the picker says, defaulting to X. "wallet" is not a handle namespace —
// it means "this needs no lookup", which is why detection can return it while
// the picker (nextProvider) never offers it.
export function detectProvider(value: string, provider?: IdentityProvider | "wallet"): AccountProvider {
  if (looksLikeAddress(value)) return "wallet";
  if (looksLikeEmail(value)) return "email";
  return provider === "discord" || provider === "email" ? provider : "x";
}

// The picker cycles rather than opening a menu — three namespaces, one tap each.
// A full email or 0x address detects itself (above) and the composer hides the
// picker for both, so "wallet" only reaches here as a stale prop; indexOf gives
// it -1, which lands on the first namespace rather than off the end.
const PROVIDER_CYCLE: IdentityProvider[] = ["x", "discord", "email"];
export const nextProvider = (p: AccountProvider): IdentityProvider =>
  PROVIDER_CYCLE[(PROVIDER_CYCLE.indexOf(p as IdentityProvider) + 1) % PROVIDER_CYCLE.length];

/** Per-provider handle validity. The canonical copy — the resolve route imports this. */
export function validHandle(provider: AccountProvider, handle: string): boolean {
  const h = handle.replace(/^@/, "").trim();
  // A wallet target is checked as an address. The resolve route never passes
  // "wallet" (it only accepts the three handle namespaces), so widening this is
  // for the composer, which validates every target through one call.
  if (provider === "wallet") return looksLikeAddress(h);
  if (provider === "x") return /^[a-zA-Z0-9_]{1,15}$/.test(h);
  if (provider === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(h);
  if (provider === "discord") return /^[a-z0-9._]{2,32}$/.test(h.toLowerCase());
  return false;
}

/**
 * Dollars, at most 2 decimals, at most 7 figures — $9,999,999.99.
 *
 * USDC carries 6 decimals, but nobody owes a friend $4.200015, and the display
 * is one giant tabular number, so a third decimal is a typo far more often than
 * an intent. The seven-figure ceiling is the same argument in the other
 * direction: past it the number stops being a debt and starts being a layout,
 * shouldering the rest of the sentence off the page at 7rem.
 *
 * Exported because the composer gates this field live — it refuses the keystroke
 * rather than accepting junk and complaining afterwards — and a second copy of
 * the rule in the input is how the two drift apart.
 */
const AMOUNT_PATTERN = /^\d{0,7}(\.\d{0,2})?$/;
export const typableAmount = (raw: string) => AMOUNT_PATTERN.test(raw);

// Rejected loudly rather than rounded silently: quietly changing someone's
// amount is worse than making them retype.
export function parseAmount(raw: string): number | null {
  const cleaned = raw.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!typableAmount(cleaned) || cleaned === "" || cleaned === ".") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Turn a draft into an executable plan, or say why not.
 *
 * `me` is the signed-in identity, used only to refuse a self-IOU. Both rails
 * would do something absurd with one: an ask would be a bill you owe yourself,
 * a settle would be a transfer to your own wallet that just burns gas.
 */
export function planIou(draft: IouDraft, me: IouIdentity): { ok: true; plan: IouPlan } | { ok: false; error: string } {
  const target = draft.target.trim();
  if (!target) return { ok: false, error: "Who is it?" };

  // A long run of hex after "0x" that isn't a full address is a mangled paste,
  // not a handle — and left to fall through it would resolve as one, minting a
  // wallet for a nonsense namespace and putting a real bill against it. X caps
  // at 15 characters, so 16+ hex digits can only ever have meant an address;
  // @0xfoobar and friends contain non-hex letters and are untouched by this.
  if (/^0x[a-fA-F0-9]{16,}$/.test(target) && !looksLikeAddress(target)) {
    return { ok: false, error: "That address is the wrong length — paste all 42 characters." };
  }

  const provider = detectProvider(target, draft.provider);
  if (!validHandle(provider, target)) {
    const expected =
      provider === "x"
        ? "letters, numbers and _ (max 15)"
        : provider === "discord"
          ? "a Discord username"
          : provider === "wallet"
            ? "a wallet address"
            : "an email address";
    return { ok: false, error: `That doesn't look like ${expected}.` };
  }
  // Lower-casing an address is safe (hex, and the leading "0x" carries no "@"),
  // and it makes the plan's handle comparable to anything else on this page.
  const handle = normalizeHandle(target);

  const amountUsd = parseAmount(draft.amount);
  if (amountUsd === null) return { ok: false, error: "How much? Dollars and cents." };

  // Refused for the same reason in both shapes: an ask would be a bill you owe
  // yourself, a settle a transfer to your own wallet that just burns gas. The
  // address check covers BOTH rails, including the two server-signed ones that
  // never had it — the browser-wallet paths re-check post-resolution, because a
  // handle can resolve to the signer's own address too.
  if (provider === "wallet") {
    if (me?.signerAddress && me.signerAddress.toLowerCase() === handle) {
      return { ok: false, error: "That's your own wallet." };
    }
  } else if (me?.handle && me.provider === provider && normalizeHandle(me.handle) === handle) {
    return { ok: false, error: "That's you." };
  }

  const note = draft.note.trim();
  return {
    ok: true,
    plan: { kind: draft.direction === "owes-me" ? "ask" : "settle", provider, handle, amountUsd, note },
  };
}

/**
 * Which wallet signs.
 *
 * Both rails need one and it is the same choice either way: an ask is
 * createBill, where msg.sender becomes the splitter and therefore the only
 * address that can collect; a settle is a transfer, where msg.sender is whose
 * USDC moves. So "who signs" is also "who gets paid" / "who pays".
 *
 * With both identities live the remembered preference decides — the same one the
 * split form's "Create as" control persists (splitsy-creator-identity), so the
 * two surfaces agree about which wallet a user creates from. With one identity
 * there is nothing to choose; with none there is nothing to sign with.
 */
export type IouSigner = "social" | "wallet";

export function pickSigner(social: string | null, wallet: string | null, preferred: IouSigner): IouSigner | null {
  if (social && wallet) return preferred;
  if (social) return "social";
  if (wallet) return "wallet";
  return null;
}

/**
 * How the target reads once it's a bill: a handle keeps its "@", an address is
 * shortened.
 *
 * This is the participant LABEL, so it is part of billMetadataHash — both the
 * server rail and the browser-wallet rail must derive it from here or a payer
 * recomputing the hash gets a different answer and the bill reads unverifiable.
 * "@<handle>" is what app/api/onchain-bills/create derives for a social row; for
 * an address row that route uses whatever label it is handed, so the short form
 * is a free choice — and the right one, since the full address is already
 * on-chain in `participantList` and this string is only ever read by a human.
 */
export const targetName = (plan: IouPlan) => (plan.provider === "wallet" ? shortAddress(plan.handle) : `@${plan.handle}`);

// The description becomes the bill's `merchant`, which is what gets hashed into
// the on-chain metadataHash — so an IOU is verifiable exactly like a receipt
// bill, and shows up titled in the settle deck, dashboard and share links. An
// empty note would render as a blank bill everywhere downstream, so it falls
// back to the sentence itself.
//
// A wallet target sends `address` + `label` instead of `provider` + `handle`:
// the create route already takes raw-address rows that way (the split form has
// always sent them), and there is nothing to resolve.
export function askBody(plan: IouPlan): {
  merchant: string;
  currency: string;
  total: number;
  participants: { provider?: IdentityProvider; handle?: string; address?: string; label?: string; amountUsd: number }[];
} {
  return {
    merchant: plan.note || `${targetName(plan)} owes me`,
    currency: "USD",
    total: plan.amountUsd,
    participants: [
      plan.provider === "wallet"
        ? { address: plan.handle, label: targetName(plan), amountUsd: plan.amountUsd }
        : { provider: plan.provider, handle: plan.handle, amountUsd: plan.amountUsd },
    ],
  };
}

// Ledger rows from the treasury plan the dashboard route already returns. It
// arrives netted per counterparty, so the sign of `netUsdc` IS the direction —
// the same grammar as the composer, one line smaller. A fully netted
// counterparty (net 0) has nothing left to state, so it drops out.
export function ledgerRows(
  positions: { counterparty: string; label: string; netUsdc: string; payBillIds: string[] }[],
): IouLedgerRow[] {
  const rows: IouLedgerRow[] = [];
  for (const p of positions) {
    const net = Number(p.netUsdc);
    if (!Number.isFinite(net) || Math.abs(net) < 0.005) continue;
    rows.push({
      id: p.counterparty,
      label: p.label,
      direction: net > 0 ? "owes-me" : "i-owe",
      amountUsd: Math.abs(net),
      payBillIds: p.payBillIds,
    });
  }
  return rows;
}

/** Signed total of the ledger: positive = you're up, negative = you're down. */
export function ledgerNet(rows: IouLedgerRow[]): number {
  const net = rows.reduce((sum, r) => sum + (r.direction === "owes-me" ? r.amountUsd : -r.amountUsd), 0);
  return Number(net.toFixed(2));
}
