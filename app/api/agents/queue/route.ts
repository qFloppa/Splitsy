// What a self-run agent reads to find work: the bills this wallet owes on that
// its own on-chain mandate would let an agent pay right now.
//
// x402-paywalled at $0.001. The payment IS the access mechanism — any agent with
// Gateway-compatible USDC can call this without a Splitsy account or session.
// Every field returned is already public on chain; the paywall recovers
// infrastructure cost and signals this is a production API, not a dev endpoint.
//
// The counterpart to /api/agents/skill, which teaches an agent how to use this.
import {
  getAutopayMandateOnchain,
  getBillIdsForParticipantOnchain,
  getBillsOnchain,
  getMandateSpendableOnchain,
  isMandateConfigured,
  MANDATE_ADDRESS,
  REGISTRY_ADDRESS,
} from "@/lib/arc-read";
import { shapeQueue, type QueueCandidate } from "@/lib/agent-queue";
import { getOnchainBillPreimage } from "@/lib/onchain-bill-preimage-repo";
import { getReputationSummaryForWallets } from "@/lib/reputation-repo";
import { billMetadataHash } from "@/lib/bill-metadata";
import { PRICES } from "@/lib/x402/pricing";
import { withGateway } from "@/lib/x402/seller";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ENDPOINT = "/api/agents/queue";

async function handler(request: Request) {
  const debtor = (new URL(request.url).searchParams.get("debtor") ?? "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(debtor)) {
    return Response.json({ error: "debtor must be a 0x wallet address" }, { status: 400 });
  }
  if (!isMandateConfigured()) {
    return Response.json({ error: "No autopay mandate contract is configured." }, { status: 503 });
  }

  const address = debtor as `0x${string}`;
  const mandate = await getAutopayMandateOnchain(address).catch(() => null);
  if (!mandate) {
    // Not an error: "no mandate" is a complete and useful answer for an agent
    // deciding whether it has anything to do.
    return Response.json({ mandate: null, bills: [], mandateAddress: MANDATE_ADDRESS });
  }

  const billIds = await getBillIdsForParticipantOnchain(address);
  const bills = await getBillsOnchain([...billIds]);

  const candidates: QueueCandidate[] = [];
  await Promise.all(
    billIds.map(async (billId, i) => {
      const bill = bills[i];
      if (!bill) return;
      const [spendable, preimage] = await Promise.all([
        getMandateSpendableOnchain(billId, address).catch(() => 0n),
        getOnchainBillPreimage(REGISTRY_ADDRESS, billId.toString()).catch(() => null),
      ]);
      if (spendable === 0n) return;

      // Deliberately not `.catch`ed, matching app/api/agents/autopay/route.ts. A
      // reputation outage must 500 this route: `creatorScore: null` already means
      // "genuinely unrated", and any agent policy that accepts an unrated creator
      // would then also accept a creator whose real score is 20. Fail closed —
      // the agent finds no work rather than unverified work.
      const score = await getReputationSummaryForWallets([bill.splitter]);
      candidates.push({
        billId: billId.toString(),
        spendable,
        creator: bill.splitter,
        creatorScore: score.avgScore,
        // The same recomputation a payer's browser does: the published details
        // hash to what the chain committed. An agent can refuse on this alone.
        verified: preimage
          ? billMetadataHash(preimage).toLowerCase() === bill.metadataHash.toLowerCase()
          : false,
        preimage,
      });
    }),
  );

  return Response.json({
    mandateAddress: MANDATE_ADDRESS,
    chain: "ARC-TESTNET",
    mandate: {
      agent: mandate.agent,
      maxPerBillUsdc: Number(mandate.maxPerBill) / 1_000_000,
      maxPerDayUsdc: Number(mandate.maxPerDay) / 1_000_000,
      headroomUsdc: Number(mandate.headroom) / 1_000_000,
      allowedCreators: mandate.allowedCreators,
    },
    bills: shapeQueue(candidates).sort((a, b) => Number(a.billId) - Number(b.billId)),
  });
}

export const GET = withGateway(handler, PRICES[ENDPOINT], ENDPOINT);
