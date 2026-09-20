// SINGULAR — this route SPENDS. It moves the signed-in user's USDC into
// HandleEscrow and writes the index row for it before answering. Its neighbour
// app/api/escrow/deposits (plural) moves no money at all; it writes that same
// row for the browser-wallet rail, which deposits without the server's help.
import { cookies } from "next/headers";
import { formatUnits, parseUnits } from "viem";
import {
  HANDLE_ESCROW_ADDRESS,
  getDepositedFromTx,
  getUsdcAllowanceOnchain,
  isHandleEscrowConfigured,
  usdcShortfallMessage,
} from "@/lib/arc-read";
import { insertEscrowDeposit } from "@/lib/escrow-deposits-repo";
import { encodeDeposit, handleHash } from "@/lib/handle-escrow";
import { validHandle } from "@/lib/iou";
import { encodeApprove } from "@/lib/registry-calldata";
import { getSessionUser } from "@/lib/session";
import { verifyWalletUnlock, WALLET_UNLOCK_COOKIE } from "@/lib/session-core";
import { prepareForUser, relayForUser, userMustSign, type UserSignedBody } from "@/lib/user-signed";
import { executeContract, InsufficientFundsError, isBroadcast, broadcastTxHash } from "@/lib/wallet-provider";
import type { IdentityProvider } from "@/lib/types";
import { ARC } from "@/lib/arc-chain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ARC_USDC_ADDRESS = ARC.usdcAddress;

const PROVIDERS: IdentityProvider[] = ["x", "discord", "email"];

// Put an IOU aside for someone who has no wallet yet: approve(escrow, amount),
// then deposit(handleHash, amount).
//
// ONE REQUEST, ONE DEPOSIT. `deposit` is create-style, exactly like `createBill`
// — every call makes a NEW deposit under a new id — so nothing here may treat a
// second call as a resume. The allowance read below picks which of the two legs
// a user-signed round trip is on, which is the same stateless trick
// [billId]/pay uses; what it is NOT is idempotency. A user who retries this
// whole request after a deposit has already landed makes a second deposit. That
// is recoverable (the depositor can always `reclaim`) and the alternative —
// pretending a standing allowance proves the deposit already happened — would
// silently swallow a payment the user meant to make.
//
// The handle hash is computed HERE from (provider, handle) rather than taken
// from the body. The hash is what the money sits under and what a release has to
// name, so a client-supplied one would be a deposit filed under whatever string
// the client felt like — unreleasable, and indistinguishable from a typo.
export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });

  // REFUSE, rather than fall back to a transfer. An unset escrow means there is
  // nowhere safe for this money to wait, and the old behaviour — transfer to a
  // freshly minted wallet nobody can reach — is the bug this route exists to fix.
  if (!isHandleEscrowConfigured()) {
    return Response.json({ error: "You can't settle to someone who hasn't signed up yet." }, { status: 503 });
  }

  const secret = process.env.SESSION_SECRET ?? "";
  const unlockToken = (await cookies()).get(WALLET_UNLOCK_COOKIE)?.value ?? "";
  if (verifyWalletUnlock(unlockToken, secret, Date.now()) !== user.id) {
    return Response.json({ error: "locked" }, { status: 403 });
  }
  if (!user.circle_wallet_id || !user.wallet_address) {
    return Response.json({ error: "Your wallet isn't provisioned yet. Log in again." }, { status: 409 });
  }

  const body = (await request.json().catch(() => null)) as
    | ({ provider?: unknown; handle?: unknown; amount?: unknown } & UserSignedBody)
    | null;

  const provider = body?.provider;
  if (typeof provider !== "string" || !PROVIDERS.includes(provider as IdentityProvider)) {
    return Response.json({ error: "invalid provider" }, { status: 400 });
  }
  const handle = body?.handle;
  if (typeof handle !== "string" || !validHandle(provider as IdentityProvider, handle)) {
    return Response.json({ error: `invalid handle for ${provider}` }, { status: 400 });
  }
  const amount = Number(body?.amount);
  // The upper bound is not a policy, it is what keeps toFixed out of exponential
  // notation: at 1e21 it returns "1e+21" and parseUnits throws, which would be a
  // 500 where a 400 is the honest answer. The composer types at most seven
  // figures, so nothing real comes near it.
  if (!Number.isFinite(amount) || amount <= 0 || amount >= 1e15) {
    return Response.json({ error: "Enter a positive amount." }, { status: 400 });
  }
  // Two decimals, matching what the composer shows and what the browser-wallet
  // rail sends (usdcToBillUnits(amountUsd.toFixed(2))) — so the same IOU lands on
  // the same number of micro-USDC whichever wallet signs it.
  const amountUnits = parseUnits(amount.toFixed(2), 6);
  if (amountUnits <= 0n) return Response.json({ error: "That rounds to nothing." }, { status: 400 });

  const hash = handleHash(provider, handle);

  // Before spending gas on a deposit that would revert inside transferFrom with
  // nothing to say for itself — same reasoning, same sentence, as [billId]/pay.
  const shortfall = await usdcShortfallMessage(user.wallet_address as `0x${string}`, amountUnits);
  if (shortfall) return Response.json({ error: shortfall }, { status: 402 });

  // ── The user signs ──────────────────────────────────────────────────────────
  if (await userMustSign(user.circle_wallet_id)) {
    // WHICH LEG, decided by the chain. An allowance already covering this amount
    // means the approve has mined and the deposit is next. Read on every pass, so
    // a browser that dies between the two legs resumes at the deposit.
    const allowance = await getUsdcAllowanceOnchain(user.wallet_address as `0x${string}`, HANDLE_ESCROW_ADDRESS);
    const leg = allowance >= amountUnits ? "deposit" : "approve";
    const [to, data] =
      leg === "deposit"
        ? ([HANDLE_ESCROW_ADDRESS, encodeDeposit(hash, amountUnits)] as const)
        : ([ARC_USDC_ADDRESS, encodeApprove(HANDLE_ESCROW_ADDRESS, amountUnits)] as const);
    // The leg is IN THE CONTEXT so an approve ticket cannot be relayed as a
    // deposit, and the hash and amount are in it so a ticket prepared to escrow
    // $5 for @dani cannot be relayed to escrow $50 for someone else.
    const context = `escrow-deposit:${hash}:${amountUnits.toString()}:${leg}`;

    if (body?.prepare === true) {
      try {
        return Response.json({
          ...(await prepareForUser({
            walletId: user.circle_wallet_id,
            userId: user.id,
            to,
            data,
            context,
          })),
          leg,
          legsRemaining: leg === "approve" ? 2 : 1,
        });
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : "Could not prepare this deposit." },
          { status: 502 },
        );
      }
    }

    if (body?.ticket !== undefined) {
      try {
        const relayed = await relayForUser({
          ticket: body.ticket,
          signature: body.signature,
          signedTransaction: body.signedTransaction,
          userId: user.id,
          walletId: user.circle_wallet_id,
          context,
        });
        if ("error" in relayed) return Response.json({ error: relayed.error }, { status: relayed.status });
        // The approve landed; the browser prepares again and the allowance read
        // above hands it the deposit.
        if (leg === "approve") return Response.json({ ok: true, txHash: relayed.tx.txHash, more: true });
        return await deposited(relayed.tx.txHash, provider, handle);
      } catch (err) {
        return failed(err, leg === "deposit");
      }
    }

    return Response.json(
      { error: "This wallet is yours — enter your export password to sign this deposit." },
      { status: 409 },
    );
  }

  // ── The server signs ────────────────────────────────────────────────────────
  try {
    await executeContract(user.circle_wallet_id, ARC_USDC_ADDRESS, encodeApprove(HANDLE_ESCROW_ADDRESS, amountUnits));
  } catch (err) {
    // Nothing is deposited yet, so every failure here is safely retryable —
    // including a broadcast-tagged one, where the worst case is an allowance set
    // twice.
    return failed(err, false);
  }
  try {
    const tx = await executeContract(user.circle_wallet_id, HANDLE_ESCROW_ADDRESS, encodeDeposit(hash, amountUnits));
    return await deposited(tx.txHash, provider, handle);
  } catch (err) {
    return failed(err, true);
  }
}

// The answer once the money has moved — AND THE ROW THAT MAKES IT FINDABLE.
//
// WRITTEN HERE, NOT LEFT TO THE CLIENT. A deposit whose index row never lands is
// the stranding this plan exists to remove wearing a friendlier sentence: the
// contract holds the money, getOpenDeposits cannot see it, and no login will
// ever release it. This route is the only place that holds the session, the
// validated handle and a chain-confirmed id at the same moment, so it is the
// only place that can record one without a second network hop that might not
// happen.
//
// Every figure describing the money comes from the Deposited event, so Ruling
// 4's identity binding is inherent rather than re-checked: the handleHash in
// that log is the one this route computed from (provider, handle) and deposited
// against. The plural route still re-reads and re-checks, because its caller is
// a browser that deposited on its own.
//
// An unreadable id, or a row that will not write, is a 202 carrying both
// identifiers: the caller must NOT retry (deposit is create-style), and the
// sender has to be shown what to reclaim.
async function deposited(txHash: string | null, provider: string, handle: string) {
  const found = await getDepositedFromTx(txHash);
  if (!found) {
    return Response.json(
      { error: "The money is in escrow, but its deposit id could not be confirmed.", txHash },
      { status: 202 },
    );
  }

  const depositId = found.id.toString();
  try {
    await insertEscrowDeposit({
      escrow_address: HANDLE_ESCROW_ADDRESS,
      deposit_id: depositId,
      provider,
      handle,
      depositor_address: found.depositor,
      amount_usdc: formatUnits(found.amount, 6),
      // Not from the body: this is the hash getDepositedFromTx just read a
      // receipt for, so it names the transaction that actually made this row.
      tx_hash: txHash,
    });
  } catch (err) {
    console.error("Escrow deposit landed but its row did not:", depositId, txHash, err);
    return Response.json(
      { error: "The money is in escrow, but Splitsy could not record who it is for.", depositId, txHash },
      { status: 202 },
    );
  }

  return Response.json({ ok: true, depositId, txHash });
}

// `mayHaveDeposited` is the whole question. A broadcast tag means the backend
// ACCEPTED the transaction — lib/circle-dcw.ts sets it when the POLL fails, not
// the send — so the money is very likely to move. [billId]/pay can report that
// as a plain failure because a repeated payDebt is safe; a repeated deposit is a
// second pile of money in escrow. So this answers 202 and tells the sender not
// to retry, rather than a 502 that hands them back a composer to press again.
function failed(err: unknown, mayHaveDeposited: boolean) {
  if (err instanceof InsufficientFundsError) {
    return Response.json({ error: "insufficient_funds" }, { status: 402 });
  }
  if (mayHaveDeposited && isBroadcast(err)) {
    return Response.json(
      {
        error: "This deposit may already have gone through — don't send it again. Check your wallet history first.",
        txHash: broadcastTxHash(err),
      },
      { status: 202 },
    );
  }
  return Response.json({ error: err instanceof Error ? err.message : "deposit failed" }, { status: 502 });
}
