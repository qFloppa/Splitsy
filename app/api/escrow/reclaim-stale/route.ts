import { getStaleOpenDeposits, markDepositReclaimed } from "@/lib/escrow-deposits-repo";
import { getWalletIdsByAddresses } from "@/lib/users-repo";
import { encodeReclaim } from "@/lib/handle-escrow";
import { HANDLE_ESCROW_ADDRESS, getEscrowDepositOnchain } from "@/lib/arc-read";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// THE POLICY HALF OF THE ESCROW BOUND, and the reason it lives here rather than
// in the contract. HandleEscrow's attester key is immutable and cannot be
// rotated, so the only defence against a leak is to bound what the contract
// holds. Two bounds do that:
//
//   - HandleEscrow.holdWindow (30 days, immutable) is the BACKSTOP. It holds
//     even if this route is switched off, forgotten, or Splitsy stops running.
//   - This sweep is the POLICY. A week is short enough that the typical balance
//     is small, long enough that someone tagged on a Friday who signs in the
//     next weekend still gets paid. Tunable with an env var precisely because
//     the contract's copy is not.
//
// WHAT A RECLAIM COSTS THE USER, said plainly: the money goes back to the sender
// and the IOU stays outstanding. The recipient signing in on day eight finds
// nothing waiting and the sender has to pay again. That is the trade — a shorter
// window means less exposure and more re-sends. Seven days is the current call,
// not a law.
const DEFAULT_RECLAIM_AFTER_DAYS = 7;

// A cap per run, not because the loop is expensive but because each leg is a
// transaction: a backlog that would take an hour of gas should be visible as
// several runs rather than one request that times out halfway and leaves no
// record of where it stopped.
const MAX_PER_RUN = 25;

type SweepResult = {
  depositId: string;
  status: "reclaimed" | "skipped" | "failed";
  reason?: string;
  txHash?: string | null;
};

function authorize(request: Request) {
  const secret = process.env.ESCROW_SWEEP_SECRET ?? process.env.CRON_SECRET;
  if (!secret) {
    return Response.json(
      { error: "Missing ESCROW_SWEEP_SECRET or CRON_SECRET on the server." },
      { status: 500 },
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized escrow sweep request." }, { status: 401 });
  }
  return null;
}

async function sweep(): Promise<{ scanned: number; results: SweepResult[] }> {
  const days = Number(process.env.ESCROW_RECLAIM_AFTER_DAYS ?? DEFAULT_RECLAIM_AFTER_DAYS);
  // A misread env var must not turn into "reclaim everything deposited so far".
  // Refusing is the safe direction: the contract's 30-day backstop still applies.
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error("ESCROW_RECLAIM_AFTER_DAYS must be a positive number of days.");
  }

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const stale = (await getStaleOpenDeposits(HANDLE_ESCROW_ADDRESS, cutoff)).slice(0, MAX_PER_RUN);
  if (stale.length === 0) return { scanned: 0, results: [] };

  // One query for every depositor rather than one per deposit. A sender with no
  // row is a non-custodial wallet this server cannot sign for — their deposit is
  // theirs to reclaim, and the contract's own expiry still closes the release
  // path on it.
  const walletIds = await getWalletIdsByAddresses(stale.map((d) => d.depositor_address));

  const { executeContract } = await import("@/lib/wallet-provider");
  const results: SweepResult[] = [];

  for (const deposit of stale) {
    const walletId = walletIds.get(deposit.depositor_address);
    if (!walletId) {
      results.push({ depositId: deposit.deposit_id, status: "skipped", reason: "depositor signs for themselves" });
      continue;
    }

    try {
      // THE TABLE IS AN INDEX, NOT AN AUTHORITY (lib/escrow-deposits-repo.ts).
      // A row can say 'open' for a deposit that was released minutes ago, and
      // reclaiming it would revert — so ask the contract before spending gas,
      // and reconcile the row when the answer is "gone".
      const onchain = await getEscrowDepositOnchain(BigInt(deposit.deposit_id), HANDLE_ESCROW_ADDRESS);
      if (onchain.amount === 0n) {
        // Left as-is rather than marked: this sweep does not know WHICH exit it
        // took, and guessing 'reclaimed' for something that was released would
        // make the IOU view claim a settled debt is still owed. The release path
        // owns that write.
        results.push({ depositId: deposit.deposit_id, status: "skipped", reason: "already left the escrow" });
        continue;
      }

      const tx = await executeContract(
        walletId,
        HANDLE_ESCROW_ADDRESS,
        encodeReclaim(BigInt(deposit.deposit_id)),
      );
      await markDepositReclaimed(HANDLE_ESCROW_ADDRESS, deposit.deposit_id, tx.txHash);
      results.push({ depositId: deposit.deposit_id, status: "reclaimed", txHash: tx.txHash });
    } catch (caught) {
      // One bad deposit must not end the run. The rest of the backlog is exactly
      // what this exists to clear, and a failure retries on the next pass
      // because the row is still 'open'.
      const reason = caught instanceof Error ? caught.message : "reclaim failed";
      console.error(`escrow-sweep: deposit ${deposit.deposit_id} failed:`, reason);
      results.push({ depositId: deposit.deposit_id, status: "failed", reason });
    }
  }

  return { scanned: stale.length, results };
}

export async function POST(request: Request) {
  const denied = authorize(request);
  if (denied) return denied;

  try {
    const { scanned, results } = await sweep();
    return Response.json({
      ok: true,
      scanned,
      reclaimed: results.filter((r) => r.status === "reclaimed").length,
      skipped: results.filter((r) => r.status === "skipped").length,
      failed: results.filter((r) => r.status === "failed").length,
      results,
    });
  } catch (caught) {
    const error = caught instanceof Error ? caught.message : "sweep failed";
    console.error("escrow-sweep:", error);
    return Response.json({ error }, { status: 500 });
  }
}

// Vercel's scheduler issues a GET. Same body, same auth — the work is
// idempotent, so there is nothing gained by making the two methods differ.
export const GET = POST;
