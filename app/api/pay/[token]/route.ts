import { isShareToken } from "@/lib/pay-link";
import { getPreimageByShareToken } from "@/lib/onchain-bill-preimage-repo";
import { REGISTRY_ADDRESS, getBillOnchain, getParticipantsOnchain } from "@/lib/arc-read";
import { getUsersByWallets } from "@/lib/users-repo";
import { buildPayRows } from "../build-rows";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/pay/<token> — the public read behind a share link. No session: the
// token IS the credential, and everything returned is already on a public chain.
export async function GET(_request: Request, ctx: RouteContext<"/api/pay/[token]">) {
  const { token } = await ctx.params;
  if (!isShareToken(token)) return Response.json({ error: "not_found" }, { status: 404 });

  const preimage = await getPreimageByShareToken(token);
  if (!preimage) return Response.json({ error: "not_found" }, { status: 404 });

  // Bill ids restart with each registry deployment, so a token minted against
  // the legacy v1 registry would otherwise open a DIFFERENT bill wearing the
  // same number — and invite a payment toward it. 404 rather than guess.
  if (preimage.registryAddress.toLowerCase() !== REGISTRY_ADDRESS.toLowerCase()) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const billId = BigInt(preimage.billId);
  let bill;
  try {
    bill = await getBillOnchain(billId);
  } catch {
    return Response.json({ error: "Could not read this bill from Arc." }, { status: 502 });
  }

  const participants = await getParticipantsOnchain(
    bill.participantList.map((addr) => ({ billId, addr })),
  );

  // Display-only enrichment; getUsersByWallets already degrades to an empty map
  // rather than throwing, so a Supabase hiccup costs handles, not the page.
  const liveHandles = new Map(
    [...(await getUsersByWallets([...bill.participantList, bill.splitter]))].map(([addr, user]) => [
      addr,
      { handle: user.handle, provider: String(user.provider) },
    ]),
  );

  const rows = buildPayRows({
    participantList: bill.participantList,
    participants,
    labels: preimage.participantLabels,
    providers: preimage.participantProviders,
    liveHandles,
  });

  const creatorLive = liveHandles.get(bill.splitter.toLowerCase());

  return Response.json({
    billId: preimage.billId,
    registryAddress: preimage.registryAddress,
    merchant: preimage.merchant,
    currency: preimage.currency,
    total: preimage.total,
    dueDate: preimage.dueDate ?? 0,
    escrowUntilFull: bill.escrowUntilFull,
    receiptUrl: preimage.receiptUrl,
    creator: {
      address: bill.splitter,
      label: creatorLive ? `@${creatorLive.handle}` : null,
      provider: creatorLive ? creatorLive.provider : null,
    },
    totalOwedUnits: bill.totalOwed.toString(),
    totalPaidUnits: bill.totalPaid.toString(),
    settled: bill.totalPaid >= bill.totalOwed,
    rows,
  });
}
