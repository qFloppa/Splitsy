import { getScout } from "@/lib/scout/wallet";

export const runtime = "nodejs";

// Resolves a Gateway transfer id to its settlement tx. A nanopayment is batched,
// so at payment time it has only an id — the on-chain hash appears once its batch
// lands (minutes later). The UI polls this to upgrade "batched abc123" into a
// real explorer link.
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id is required." }, { status: 400 });

  try {
    const transfer = await getScout().gateway.getTransferById(id);
    return Response.json({
      id: transfer.id,
      status: transfer.status,
      txHash: (transfer as { txHash?: string }).txHash ?? null,
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Transfer lookup failed." },
      { status: 502 },
    );
  }
}
