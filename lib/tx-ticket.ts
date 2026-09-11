// A prepared transaction the server will relay back, and nothing else.
//
// THE PROBLEM THIS SOLVES. A user-signed payment is three steps: the server
// prepares an unsigned transaction (the nonce and the gas are chain reads), the
// browser authorizes it with the wallet's owner key, and the server relays it to
// Privy and broadcasts. Between step one and step three the transaction is in the
// client's hands, so the relay has to answer: are these the bytes I prepared?
//
// app/api/wallet/send answered it by RE-DERIVING the calldata from {to, amount}
// and comparing. That works for one route with two parameters. It does not
// generalise: every other route would need its own re-derivation — encodePayDebt
// from a bill id, encodeClaim from a claimable amount read on chain, an
// executeBatch of calls assembled from a settlement plan — and each one is a fresh
// chance to compare the wrong field, or to forget that the nonce and the gas limit
// were never checked at all.
//
// SO THE SERVER SIGNS ITS OWN WORK INSTEAD. The prepared transaction goes out with
// an HMAC over it, and the relay verifies that HMAC and uses THE BYTES FROM THE
// TICKET rather than anything the client sent. The client cannot substitute a
// transaction because its copy is never read; it can only return the ticket intact
// or fail verification. One guard, every route, and it covers the nonce, the gas
// and the chain id — which the re-derivation approach never did.
//
// Stateless on purpose. Vercel puts the prepare and the relay in different
// instances, so an in-memory map would not survive the round trip and a table
// would mean a write, a read and a sweep for something that lives eight seconds.
import { sign, signaturesMatch } from "./session-core.ts";

// Long enough for a person to read a confirmation and press a button, short enough
// that a prepared nonce is probably still current. A stale ticket is not dangerous
// — the nonce is consumed or the chain moved on, and the send fails — but a
// bounded life keeps a leaked ticket from being useful later.
export const TX_TICKET_TTL_MS = 120_000;

// DOMAIN-SEPARATED from every cookie in session-core, for the reason its own
// comment gives: these share a secret, so without a prefix a value lifted from one
// could verify as another. A session cookie replayed as a ticket would be nonsense
// rather than dangerous — the payload would not parse — but the separation is free
// and the failure mode of getting it wrong is not.
const TICKET_DOMAIN = "txticket.";

export type TxTicket = {
  // The exact bytes Privy will be asked to sign. Opaque here; built by
  // lib/privy-wallet.ts:prepareTransfer and relayed back untouched.
  transaction: Record<string, unknown>;
  // WHO. Bound so a ticket prepared for one account cannot be relayed by another,
  // even though the relay re-checks the session anyway — defence in depth costs one
  // string comparison.
  userId: string;
  // WHICH WALLET. Bound because the relay names the wallet to Privy, and a ticket
  // that could name a different one would be a request to sign from someone else's
  // account.
  walletId: string;
  // WHAT THIS PAYS FOR, route-defined and opaque here: a debt id, a bill id and
  // leg, a tab address. THE RELAY MUST CHECK IT. Without it a ticket prepared for
  // debt A could be relayed while the route marks debt B paid — the transaction
  // would be right and the ledger wrong.
  context: string;
  expiresAt: number;
};

// Sign a prepared transaction so the relay can trust it came from here.
//
// JSON.stringify is the canonical form, and it is safe HERE in a way it would not
// be for a signature Privy verifies: both ends are this server, and the relay
// compares the STRING it was handed rather than re-serialising a parsed object, so
// key order never has to be agreed with anyone.
export function signTxTicket(ticket: TxTicket, secret: string): string {
  const payload = Buffer.from(JSON.stringify(ticket)).toString("base64url");
  return `${payload}.${sign(`${TICKET_DOMAIN}${payload}`, secret)}`;
}

// The ticket back, or null. NEVER THROWS: every failure is the same answer —
// "this is not a ticket I issued" — and a caller that had to tell a malformed
// ticket from an expired one would be tempted to say which, which tells an
// attacker where they are.
//
// The payload is verified BEFORE it is parsed. Parsing first would run
// JSON.parse over attacker-controlled bytes on every request, and the whole point
// is that unsigned input never reaches the logic below.
export function verifyTxTicket(token: string, secret: string, now: number): TxTicket | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;

  const payload = token.slice(0, dot);
  if (!signaturesMatch(token.slice(dot + 1), sign(`${TICKET_DOMAIN}${payload}`, secret))) return null;

  let ticket: TxTicket;
  try {
    ticket = JSON.parse(Buffer.from(payload, "base64url").toString());
  } catch {
    return null;
  }

  // Shape-checked even though it verified: a ticket signed by an OLDER build of
  // this file could carry a different shape, and the relay would then hand
  // `undefined` to Privy as a wallet id.
  if (
    typeof ticket?.userId !== "string" ||
    typeof ticket?.walletId !== "string" ||
    typeof ticket?.context !== "string" ||
    typeof ticket?.expiresAt !== "number" ||
    typeof ticket?.transaction !== "object" ||
    ticket.transaction === null
  ) {
    return null;
  }
  if (!(ticket.expiresAt > now)) return null;

  return ticket;
}
