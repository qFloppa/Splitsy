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
  | { ok: false; error: string; status: number; locked?: boolean };

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
      return { ok: false, error: plan.error ?? "Could not prepare this payment.", status: prepared.status, locked: prepared.status === 403 };
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
      return { ok: false, error: data.error ?? "Payment failed.", status: relayed.status, locked: relayed.status === 403 };
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
