// PLURAL — this route RECORDS. It writes the index row that lets a login find
// money already sitting in HandleEscrow, and moves nothing itself. Its
// neighbour app/api/escrow/deposit (singular) is the one that spends.
import { formatUnits } from "viem";
import { HANDLE_ESCROW_ADDRESS, getEscrowDepositOnchain, isHandleEscrowConfigured } from "@/lib/arc-read";
import { insertEscrowDeposit } from "@/lib/escrow-deposits-repo";
import { handleHash } from "@/lib/handle-escrow";
import { validHandle } from "@/lib/iou";
import { getSessionUser } from "@/lib/session";
import type { IdentityProvider } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROVIDERS: IdentityProvider[] = ["x", "discord", "email"];

// Record a deposit that is already on chain.
//
// EVERYTHING THAT MATTERS IS READ BACK FROM THE CHAIN. The body names WHICH
// deposit; the chain says what is in it. Two separate reasons:
//
//   the amount — a client-supplied figure would let a caller file a row
//     claiming more than they deposited. The contract would refuse to pay it
//     out, but the ledger would be lying to the user until it did.
//   the handleHash — without checking it, anyone could file somebody else's
//     open deposit under their OWN handle and have the login path release it to
//     them. The amount check alone does not stop that; this is the one that
//     makes the row an honest claim about who the money is for.
//
// What is deliberately NOT checked is that the depositor is this session's
// wallet. The browser-wallet rail deposits from a connected EOA that no session
// column names, and recording somebody else's deposit under its own true handle
// indexes a fact rather than a lie — it earns the filer nothing.
export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  if (!isHandleEscrowConfigured()) {
    return Response.json({ error: "The handle escrow isn't configured." }, { status: 503 });
  }

  const body = (await request.json().catch(() => null)) as {
    escrowAddress?: unknown;
    depositId?: unknown;
    provider?: unknown;
    handle?: unknown;
    txHash?: unknown;
  } | null;

  // Only this deployment's escrow. Ids restart at 1 in every deployment, so a row
  // naming a different address would send a login chasing the wrong contract's
  // deposit number — which is a release attempt against somebody else's money.
  const escrowAddress = typeof body?.escrowAddress === "string" ? body.escrowAddress : "";
  if (escrowAddress.toLowerCase() !== HANDLE_ESCROW_ADDRESS.toLowerCase()) {
    return Response.json({ error: "That isn't this deployment's escrow." }, { status: 400 });
  }

  const depositId = typeof body?.depositId === "string" ? body.depositId : "";
  if (!/^[0-9]+$/.test(depositId)) return Response.json({ error: "bad deposit id" }, { status: 400 });

  const provider = body?.provider;
  if (typeof provider !== "string" || !PROVIDERS.includes(provider as IdentityProvider)) {
    return Response.json({ error: "invalid provider" }, { status: 400 });
  }
  const handle = body?.handle;
  if (typeof handle !== "string" || !validHandle(provider as IdentityProvider, handle)) {
    return Response.json({ error: `invalid handle for ${provider}` }, { status: 400 });
  }

  let onChain;
  try {
    onChain = await getEscrowDepositOnchain(BigInt(depositId));
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "escrow read failed" }, { status: 502 });
  }

  // Zero is the contract's own "gone": both exits delete the struct, so this is
  // equally "never existed", "already released" and "already reclaimed". None of
  // the three is a row worth writing.
  if (onChain.amount === 0n) {
    return Response.json({ error: "No such deposit." }, { status: 404 });
  }
  if (onChain.handleHash.toLowerCase() !== handleHash(provider, handle).toLowerCase()) {
    return Response.json({ error: "That deposit isn't for this handle." }, { status: 403 });
  }

  try {
    await insertEscrowDeposit({
      escrow_address: HANDLE_ESCROW_ADDRESS,
      deposit_id: depositId,
      provider,
      handle,
      depositor_address: onChain.depositor,
      amount_usdc: formatUnits(onChain.amount, 6),
      tx_hash: typeof body?.txHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(body.txHash) ? body.txHash : null,
    });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "could not record deposit" }, { status: 502 });
  }

  return Response.json({ ok: true });
}
