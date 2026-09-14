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
import { decodeFunctionData, erc20Abi, formatUnits } from "viem";
import { ARC_USDC_ADDRESS } from "@/lib/recurring-contracts";
import { ownerKeyFor } from "./session-owner-key";
import { privyUiActive, signerOrNull, type PreparedPlan } from "./privy-signer";

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

// WHAT THE USER IS BEING ASKED TO APPROVE, in Privy's modal, in words.
//
// Derived from the route rather than passed in, so the nine call sites do not
// change. A route with no entry here still gets a prompt — it just gets a generic
// sentence above it, which is the right failure for a new route somebody forgot
// to add.
const PAYMENT_LABEL: Record<string, { description: string; action: string }> = {
  "/api/wallet/send": { description: "Send USDC from your Splitsy wallet.", action: "Send USDC" },
  // The recipient has no wallet yet, so this holds the money for their handle
  // instead of sending it. Says "held" rather than "sent" because that is the
  // difference the user is being asked to approve — and it stays reclaimable.
  "/api/escrow/deposit": { description: "Held in escrow until they sign up. You can take it back.", action: "Escrow an IOU" },
  "/api/debts/": { description: "Pay what you owe on this bill.", action: "Pay a debt" },
  "/api/onchain-bills/": { description: "Settle your share of this on-chain bill.", action: "Pay a bill" },
  "/api/recurring/": { description: "Authorise this recurring tab.", action: "Recurring tab" },
  "/api/treasury/settle": { description: "Settle these balances in one go.", action: "Settle up" },
  "/api/pay/": { description: "Pay this Splitsy payment link.", action: "Pay a link" },
  "/api/agents/mandate": { description: "Authorise your agent to pay on your behalf.", action: "Agent mandate" },
};

// THE FIGURE, READ OUT OF THE BYTES THE USER IS ABOUT TO SIGN.
//
// Not fetched, not remembered from the form, not recomputed from the row — decoded
// from the calldata itself, so what the prompt says and what gets signed cannot
// disagree. That is the only version of this worth showing: a number carried
// alongside the payload could drift from it, and this prompt is the last thing
// between the user and their money.
//
// Only USDC transfer and approve, and only at Arc's USDC address. Every other
// call this app prepares — payDebt, claim, settle — moves money that was already
// authorised by an approve in the leg before, and guessing at an amount inside a
// registry call would be inventing one. Those get the sentence with no figure,
// which is honest; `null` here means "this leg names no amount", not "unknown".
function decodedAmount(plan: PreparedPlan): { amount: string; isApprove: boolean } | null {
  if (plan.to.toLowerCase() !== (ARC_USDC_ADDRESS as string).toLowerCase()) return null;
  try {
    const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data: plan.data as `0x${string}` });
    if (functionName !== "transfer" && functionName !== "approve") return null;
    return { amount: `${formatUnits(args[1] as bigint, 6)} USDC`, isApprove: functionName === "approve" };
  } catch {
    // Not an ERC-20 call at all, or calldata this abi cannot read. No figure.
    return null;
  }
}

function paymentSummary(url: string, plan: PreparedPlan): { description: string; action: string } {
  const label =
    Object.entries(PAYMENT_LABEL).find(([prefix]) => url.startsWith(prefix))?.[1] ??
    { description: "Approve this Splitsy payment on Arc Testnet.", action: "Payment" };
  const decoded = decodedAmount(plan);
  if (!decoded) return label;
  // AN APPROVE IS A CEILING, NOT A PAYMENT, and saying "12 USDC" for one would be
  // wrong twice over: nothing moves in that transaction, and the figure is a
  // limit rather than an amount. Taken from the decoded function name rather than
  // a selector constant, so there is no magic hex to get wrong.
  return {
    description: decoded.isApprove
      ? `Allow up to ${decoded.amount} to be taken for this payment. ${label.description}`
      : `${decoded.amount}. ${label.description}`,
    action: label.action,
  };
}

// The same three steps as signedSend, with the middle one moved into Privy's UI.
//
// THE SERVER'S PREPARE STEP IS REUSED VERBATIM, and that is deliberate rather
// than incidental: the nonce and the gas are chain reads, and ARC_TESTNET_RPC may
// be a keyed endpoint that has no business reaching a browser. So the server goes
// on building the transaction and broadcasting it — only the SIGNATURE moved,
// from lib/export-crypto to Privy's own prompt. The server re-checks that the
// bytes coming back are the bytes it prepared (lib/privy-wallet.ts:matchesPrepared),
// because on this path the client is what produced them.
//
// The multi-leg loop is the same one, for the same reason: a bill payment is
// approve-then-payDebt and the second leg's nonce follows the first, so the chain
// decides what comes next. A user approving a bill sees two prompts, which is the
// honest number — two transactions are being signed.
async function privySend(
  url: string,
  send: NonNullable<ReturnType<typeof signerOrNull>>,
  body: Record<string, unknown>,
): Promise<SignedSendResult> {
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

    let signedTransaction: string;
    try {
      signedTransaction = await send(plan.transaction as PreparedPlan, paymentSummary(url, plan.transaction as PreparedPlan));
    } catch (err) {
      // Dismissing the prompt lands here, and it is not a failure worth shouting
      // about — the user decided not to pay. Reported with the other refusals so
      // the panels that already render `error` need no new branch.
      return { ok: false, error: err instanceof Error ? err.message : "You did not approve this payment.", status: 401 };
    }

    const relayed = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // The TICKET goes back with the bytes, and the server relays the transaction
      // the ticket carries — not one the client names. Same property as the
      // authorization path; here the bytes are additionally compared against it.
      body: JSON.stringify({ ...body, ticket: plan.ticket, signedTransaction }),
    });
    const data = await relayed.json();
    if (!relayed.ok) {
      return { ok: false, error: data.error ?? "Payment failed.", status: relayed.status, locked: relayed.status === 403, data };
    }
    last = data;
    if (data.more !== true) return { ok: true, data };
  }

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
  if (error === "privy_signer_missing") {
    return "Your wallet isn't connected yet — sign in with Privy, then try this payment again.";
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
//
// THE PRIVY BRANCH COMES FIRST AND IS ABSOLUTE. When this deployment asks users
// to approve in Privy's own modal, there is no other signer for a pay wallet:
// the wallet is Privy's embedded one, Splitsy holds no key to it, and falling
// through would put the user in front of "enter your export password" for a
// password that does not exist. A missing signer is therefore a refusal with its
// own message rather than a fallback — the same shape signedSend uses when no
// owner key is cached, so the panels need no new branch.
export async function walletPost(url: string, body: Record<string, unknown> = {}): Promise<SignedSendResult> {
  if (privyUiActive()) {
    const send = signerOrNull();
    if (!send) return { ok: false, error: "privy_signer_missing", status: 401 };
    return privySend(url, send, body);
  }

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
