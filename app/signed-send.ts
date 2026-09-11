"use client";

// The browser half of a user-signed payment, for every surface that spends.
//
// ONE IMPLEMENTATION, because the alternative is each panel growing its own copy
// of "prepare, sign, relay" — and the signing step is the one place a mistake is
// expensive. app/XAuthControl.tsx's SendTab had the first copy; this is that flow
// with the route and the body made parameters.
//
// THE KEY NEVER COMES BACK HERE. It lives in ./session-owner-key, module-scoped,
// and is read at the moment of signing. Nothing in this file returns it, stores it,
// or accepts it as an argument from a caller that might hold it longer.
import { ownerKeyFor } from "./session-owner-key";

export type SignedSendResult =
  | { ok: true; data: Record<string, unknown> }
  // `data` is the ERROR body, carried rather than reduced to its message: some
  // routes answer insufficient_funds with the figures (neededUsdc, availableUsdc)
  // and a panel that only had the string would have to tell the user "needs more
  // USDC" when it could tell them how much.
  | { ok: false; error: string; status: number; locked?: boolean; data?: Record<string, unknown> };

// Ask the server to prepare, sign the authorization here, send it back.
//
// LOOPS FOR MULTI-LEG PAYMENTS. A bill payment is approve-then-payDebt, and the
// second leg's nonce follows the first, so it cannot be prepared until the first
// has mined. The server answers `more: true` when another leg is outstanding and
// this asks again — the chain decides which leg comes next, so there is no
// sequence tracked here and a reload resumes wherever the chain actually is.
//
// `body` is whatever the route needs to identify the payment — a debt id is in the
// URL, an amount goes in the body. It is sent on BOTH requests: the prepare step
// needs it to build the transaction, and the relay step needs it to find the row it
// is about to write. The server binds the two together with a ticket, so a mismatch
// between them is caught there rather than trusted here.
export async function signedSend(
  url: string,
  address: string,
  body: Record<string, unknown> = {},
): Promise<SignedSendResult> {
  const key = ownerKeyFor(address);
  if (!key) {
    // Not an error the caller can retry past — the password has to be entered
    // first. Surfaced as a distinct message so a panel can route the user to it.
    return { ok: false, error: "unlock_owner_key", status: 401 };
  }

  // Bounded so a server that always answered `more: true` could not spin here.
  // 32 is far past any real sequence — the longest is a social pay-link covering
  // one approval plus one leg per person — while still being a hard stop rather
  // than a promise about how many legs the server may ask for.
  const MAX_LEGS = 32;
  let last: Record<string, unknown> = {};

  for (let leg = 0; leg < MAX_LEGS; leg++) {
    const prepared = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, prepare: true }),
    });
    const plan = await prepared.json();
    if (!prepared.ok) {
      return { ok: false, error: plan.error ?? "Could not prepare this payment.", status: prepared.status, locked: prepared.status === 403, data: plan };
    }

    // The bytes Privy verifies. rpcRequestInput and canonicalPayload are the same
    // pair the export path uses — drift here is a 401 that says nothing about why,
    // which is why they have a golden test against the SDK's own formatter.
    const crypto = await import("@/lib/export-crypto");
    const signature = crypto.signAuthorization(
      crypto.canonicalPayload(crypto.rpcRequestInput(plan.walletId, plan.appId, plan.transaction)),
      key,
    );

    const relayed = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // The TICKET goes back, not the transaction: the server relays its own bytes
      // and never reads a client-supplied transaction. Sending one would be ignored.
      body: JSON.stringify({ ...body, ticket: plan.ticket, signature }),
    });
    const data = await relayed.json();
    if (!relayed.ok) {
      return { ok: false, error: data.error ?? "Payment failed.", status: relayed.status, locked: relayed.status === 403, data };
    }
    last = data;
    if (data.more !== true) return { ok: true, data };
  }

  // Every leg succeeded but the server still wants another. Reported as success
  // with what the last leg returned, because money DID move and calling it a
  // failure would invite a retry of a payment that may be complete.
  return { ok: true, data: last };
}

// Whether this wallet signs for itself. Routes answer it per-payment, but a panel
// needs it up front to decide whether to ask for the password at all.
export async function ownerKeyNeeded(): Promise<{ needed: boolean; address: string | null; hasKey: boolean }> {
  const res = await fetch("/api/wallet/export");
  if (!res.ok) return { needed: false, address: null, hasKey: false };
  const status = await res.json();
  const needed = Boolean(status.claimed);
  return {
    needed,
    address: status.address ?? null,
    hasKey: needed && status.address ? ownerKeyFor(status.address) !== null : false,
  };
}

// THE MEMO. Whether a wallet is claimed changes once in its life, and every
// spending surface asked the same question on every click — a round trip before
// each payment to learn something that cannot have changed since the last one.
//
// The PROMISE is cached, not the answer, so several panels mounting at once share
// one request instead of racing to make four.
let claimStatus: Promise<{ needed: boolean; address: string | null; hasKey: boolean }> | null = null;

// Called by the two ceremonies that make the answer change — setup and claim. The
// memo is per-tab and those both happen in the tab that then wants to spend, so
// without this the first payment after setup would take the server-signed path and
// get a refusal from a server that holds no key.
export function forgetClaimStatus(): void {
  claimStatus = null;
}

// The two errors from a spend that are SENTINELS rather than prose, translated
// once. Every panel had its own copy of this ternary, which meant the same
// condition reached the user in slightly different words depending on which button
// they pressed — and meant a new sentinel had to be remembered in eight places.
// Anything else is already a message and passes through untouched.
export function payErrorMessage(error: string): string {
  if (error === "unlock_owner_key") {
    return "This wallet is yours — open the wallet panel and enter your export password to sign payments.";
  }
  if (error === "insufficient_funds") return "Your wallet needs more test USDC to cover this.";
  return error;
}

// POST to a route that may spend from the user's wallet, whichever side holds the
// key.
//
// ONE FUNCTION FOR BOTH PATHS, because the choice is not the caller's business:
// whether Splitsy can still sign for a wallet is a property of the wallet, and
// every panel that re-derived that decision locally was a panel that could get it
// wrong in a way that only shows up as a 401 mid-payment. A claimed wallet signs
// its own payment here (prepare → sign → relay, in signedSend); an unclaimed one
// takes the plain POST it always did; both reduce to the same {ok, error} shape so
// callers branch once.
//
// FAILING TO READ THE STATUS READS AS UNCLAIMED, deliberately. That is the old
// behaviour, and the server refusing a payment it cannot sign is a recoverable
// error message — where wrongly deciding the browser must sign would demand a
// password from a user who has never set one.
export async function walletPost(url: string, body: Record<string, unknown> = {}): Promise<SignedSendResult> {
  claimStatus ??= ownerKeyNeeded();
  const claimed = await claimStatus.catch(() => ({ needed: false, address: null, hasKey: false }));

  if (claimed.needed && claimed.address) return signedSend(url, claimed.address, body);

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return res.ok
    ? { ok: true, data }
    : { ok: false, error: data.error ?? "Payment failed.", status: res.status, locked: res.status === 403, data };
}
