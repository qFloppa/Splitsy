// The server half of a user-signed payment, for routes that are not
// app/api/wallet/send.
//
// EVERY ROUTE THAT SPENDS FROM A USER'S PAY WALLET has the same three-step shape
// once that wallet is theirs: prepare an unsigned transaction, let the browser
// authorize it, relay it. The two functions here are that shape, so a route adds a
// branch rather than a protocol — and so the ticket verification, the session
// re-check and the context binding are written once rather than nine times.
//
// WHY THE ROUTE STILL OWNS ITS LEDGER WRITES. These helpers deliberately do not
// touch the caller's database rows. app/api/debts/[id]/pay has to mark a debt
// `settling` before it can mark it `paid`, and the onchain-bills routes queue an
// ERC-8004 score; that bookkeeping is the part each route must get right for
// itself, and hiding it behind a shared helper would be the wrong abstraction —
// one implementation, nine different meanings.
import { isCustodial, getPrivyWalletByWalletId } from "./privy-wallets-repo.ts";
import { signTxTicket, TX_TICKET_TTL_MS, verifyTxTicket } from "./tx-ticket.ts";
import { walletProviderName } from "./wallet-provider.ts";
import type { TxResult } from "./wallet-provider.ts";

// Whether this wallet needs the user to sign, or the server still can.
//
// READ FROM OUR OWN ROW, not from Privy: it is one query the route has usually
// already made, and the alternative is a network call on every payment to learn
// something we recorded ourselves. The row is written only after a claim is
// verified (app/api/wallet/claim), so it cannot claim more than is true.
//
// A wallet we cannot find is treated as CUSTODIAL, which is the safe direction:
// the server attempts the send, and if it is wrong Privy refuses with 401 and the
// caller gets NotOurWalletError. The inverse default would tell a user to sign for
// a wallet that has no key in their browser.
export async function userMustSign(walletId: string): Promise<boolean> {
  if (walletProviderName() !== "privy") return false;
  const row = await getPrivyWalletByWalletId(walletId).catch(() => null);
  return row ? !isCustodial(row) : false;
}

export type PreparedTicket = {
  transaction: Record<string, unknown>;
  ticket: string;
  walletId: string;
  appId: string | undefined;
};

// Step one: build the transaction and hand it out with an HMAC over it.
//
// `context` is what the relay will demand back, and it must name the thing being
// paid for — a debt id, a bill id and leg. A route that passes a constant here has
// a ticket that is valid for any of its own payments, which is how a prepared
// transaction for one debt gets relayed while another is marked paid.
export async function prepareForUser(args: {
  walletId: string;
  userId: string;
  to: `0x${string}`;
  data: `0x${string}`;
  context: string;
}): Promise<PreparedTicket> {
  const secret = process.env.SESSION_SECRET ?? "";
  if (!secret) throw new Error("SESSION_SECRET is not set");

  const { prepareUserSignedCall } = await import("./privy-wallet.ts");
  const prepared = await prepareUserSignedCall(args.walletId, args.to, args.data);

  return {
    transaction: prepared.transaction,
    ticket: signTxTicket(
      {
        transaction: prepared.transaction,
        userId: args.userId,
        walletId: args.walletId,
        context: args.context,
        expiresAt: Date.now() + TX_TICKET_TTL_MS,
      },
      secret,
    ),
    walletId: args.walletId,
    // Not a secret: it is in every Privy request the browser's signature covers,
    // and the browser cannot build that signature without it.
    appId: process.env.PRIVY_APP_ID,
  };
}

// Step three: verify the ticket and relay the bytes IT carries.
//
// THE CLIENT'S COPY OF THE TRANSACTION IS NEVER READ. That is the whole security
// property: whatever it sends back, the transaction relayed is the one this server
// signed, so there is nothing to compare and nothing to get wrong. A tampered
// ticket fails the HMAC; an intact one carries the original bytes.
//
// Three bindings are checked, and each closes a different substitution:
//   userId   — a ticket from another account, replayed by this one.
//   walletId — a ticket naming a wallet other than the one the session resolved.
//   context  — a ticket for this user's OTHER payment, relayed while the route
//              writes the ledger row for this one.
export async function relayForUser(args: {
  ticket: unknown;
  signature: unknown;
  userId: string;
  walletId: string;
  context: string;
  pollMs?: number;
}): Promise<{ tx: TxResult } | { error: string; status: number }> {
  if (typeof args.ticket !== "string" || typeof args.signature !== "string" || !args.signature) {
    return { error: "Expected a prepared transaction and its signature.", status: 400 };
  }

  const secret = process.env.SESSION_SECRET ?? "";
  if (!secret) return { error: "Sessions are not configured.", status: 502 };

  const ticket = verifyTxTicket(args.ticket, secret, Date.now());
  // ONE MESSAGE for every rejection — forged, expired, malformed. The client's
  // remedy is identical in all three (prepare again), and naming which one tells a
  // prober how close they got.
  if (!ticket) {
    return { error: "That payment request expired or was not recognised. Please try again.", status: 400 };
  }
  if (ticket.userId !== args.userId || ticket.walletId !== args.walletId || ticket.context !== args.context) {
    return { error: "That payment request does not match this payment.", status: 400 };
  }

  const { sendUserSigned } = await import("./privy-wallet.ts");
  return { tx: await sendUserSigned(ticket.walletId, ticket.transaction, args.signature, args.pollMs) };
}

// THE WHOLE BRANCH, for a route whose payment is one contract call.
//
// Most migrated routes are the same four lines: if the user must sign, either
// hand out a ticket or relay one, and otherwise do what the route always did. This
// collapses that into a single call so the route keeps its guards and its ledger
// writes and gains almost nothing else.
//
// Returns `null` when the server should sign — meaning the wallet is custodial, or
// this is the Circle stack — so the caller's existing executeContract path runs
// untouched. That is the default, and it is what keeps this safe to add to a route
// before anyone has claimed anything.
//
// NOT for multi-leg payments. A route that sends approve-then-pay has to decide
// which leg it is on by reading the chain, and a helper that returned one ticket
// would silently only ever do the first. Those routes call prepareForUser and
// relayForUser directly, with their own leg in the context.
//
// What the two extra passes look like on the wire. A route that already parses its
// own body can intersect this with its own shape; one that does not can parse
// straight into it.
export type UserSignedBody = { prepare?: unknown; ticket?: unknown; signature?: unknown };

// TAKES THE PARSED BODY, not the Request. A body can only be read once, and
// several of these routes have already read it to find the bill id they are acting
// on — a second `request.json()` in here would throw on exactly those callers.
export async function userSignedLeg(args: {
  body: UserSignedBody | null;
  walletId: string;
  userId: string;
  to: `0x${string}`;
  data: `0x${string}`;
  context: string;
  pollMs?: number;
}): Promise<{ response: Response } | { tx: TxResult } | null> {
  if (!(await userMustSign(args.walletId))) return null;

  const body = args.body;

  if (body?.prepare === true) {
    try {
      const prepared = await prepareForUser({
        walletId: args.walletId,
        userId: args.userId,
        to: args.to,
        data: args.data,
        context: args.context,
      });
      return { response: Response.json(prepared) };
    } catch (err) {
      return {
        response: Response.json(
          { error: err instanceof Error ? err.message : "Could not prepare this payment." },
          { status: 502 },
        ),
      };
    }
  }

  if (body?.ticket !== undefined) {
    const relayed = await relayForUser({
      ticket: body.ticket,
      signature: body.signature,
      userId: args.userId,
      walletId: args.walletId,
      context: args.context,
      pollMs: args.pollMs,
    });
    if ("error" in relayed) return { response: Response.json({ error: relayed.error }, { status: relayed.status }) };
    return { tx: relayed.tx };
  }

  // A claimed wallet reached here with neither a prepare nor a ticket, which means
  // a client that has not been taught to sign. Said plainly: the server cannot do
  // this for them, and a retry of the same request will not help.
  return {
    response: Response.json(
      { error: "This wallet is yours — enter your export password to sign this payment." },
      { status: 409 },
    ),
  };
}
