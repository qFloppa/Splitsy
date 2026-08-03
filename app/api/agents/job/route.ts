// The whole life of one ERC-8183 job, for the row that expands in the audit
// trail. Three sources, because no single one holds the story:
//
//   * the CHAIN, twice — getJob(jobId) for the job as the contract holds it
//     right now, and the contract's own logs for the transaction behind each
//     step of the ceremony. The steps are rebuilt rather than stored, so a
//     settlement from before this endpoint existed still shows all six rows.
//   * autopay_log, for the job id and the settlement hash. It is also the
//     AUTHORISATION: only jobs in the caller's own log are readable here, which
//     is why the bill id is looked up against listAutopayLog rather than being
//     trusted as a job id from the client.
//   * x402_payments, for the review the Settler bought before settling.
//
// Session-scoped and never cached: the job status moves (funded → submitted →
// completed) while the panel is open, and a cached "funded" would read as stuck.
import { getProvenWalletAccount, getSessionUser } from "@/lib/session";
import { listAutopayLog } from "@/lib/agents-repo";
import { getJobOnchain, getJobTrail } from "@/lib/erc8183";
import { listPaymentsForBill } from "@/lib/x402/payments-repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });

  const billId = new URL(request.url).searchParams.get("billId");
  if (!billId || !/^\d+$/.test(billId)) {
    return Response.json({ error: "Expected ?billId=<number>." }, { status: 400 });
  }

  // The trail in the panel spans both of this browser's accounts, so a row from
  // the proven one must expand rather than 404 — and the authorisation widens by
  // exactly the same proof the listing does, never by the address in the query.
  // Anything looser would make this endpoint the way to read another account's
  // jobs by naming its wallet.
  const proven = await getProvenWalletAccount(
    user.id,
    new URL(request.url).searchParams.get("connected") ?? "",
  ).catch(() => null);
  const readable = proven ? [user.id, proven.id] : [user.id];
  const entry = (await listAutopayLog(readable)).find((row) => row.billId === billId && row.jobId);
  if (!entry?.jobId) {
    return Response.json({ error: "No job on this bill." }, { status: 404 });
  }

  const jobId = BigInt(entry.jobId);
  const settlementTx = entry.txHash;

  // Each source fails on its own. A dead RPC must still let the review payment
  // and the settlement hash through — a half-empty trail is worth more than an
  // error that hides the parts that were readable.
  const [job, steps, payments] = await Promise.all([
    getJobOnchain(jobId).catch(() => null),
    settlementTx
      ? getJobTrail(jobId, settlementTx as `0x${string}`).catch(() => [])
      : Promise.resolve([]),
    listPaymentsForBill(billId),
  ]);

  return Response.json({
    jobId: entry.jobId,
    settlementTx,
    feeUsdc: entry.feeUsdc,
    // Every bigint out of getJob is stringified: JSON.stringify throws on them,
    // and a Number() would quietly round expiredAt.
    job: job
      ? {
          client: job.client,
          provider: job.provider,
          evaluator: job.evaluator,
          description: job.description,
          budgetUsdc: Number(job.budget) / 1e6,
          expiredAt: Number(job.expiredAt),
          status: job.status,
          statusName: job.statusName,
          hook: job.hook,
        }
      : null,
    steps,
    payments,
  });
}
