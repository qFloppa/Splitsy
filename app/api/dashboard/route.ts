import { getSessionUser } from "@/lib/session";
import {
  getBillIdsForSplitterOnchain,
  getBillIdsForParticipantOnchain,
  getBillOnchain,
  getParticipantOnchain,
  REGISTRY_ADDRESS,
} from "@/lib/arc-read";
import { listRecipientTabsOnchain } from "@/lib/recurring-read";
import { getOnchainBillPreimage } from "@/lib/onchain-bill-preimage-repo";
import { getReputationSummary } from "@/lib/reputation-repo";
import { buildDashboard, type CreatedBill, type OwedBill } from "@/lib/dashboard-aggregate";
import { DEMO_DASHBOARD } from "@/lib/dashboard-fixture";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Orchestration over already-tested parts (reads → buildDashboard). No unit test
// here; buildDashboard is covered by dashboard-aggregate.test.ts, so this route
// only wires reads to it. bigint never crosses Response.json — buildDashboard
// returns strings/numbers only.
export async function GET(request: Request) {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });

  // Demo/empty-state preview: return the static fixture with NO chain/DB read.
  if (new URL(request.url).searchParams.get("demo") === "1") {
    return Response.json(DEMO_DASHBOARD);
  }

  const myWallet = (user.wallet_address ?? "").toLowerCase() as `0x${string}`;
  if (!myWallet) return Response.json({ error: "Wallet not provisioned" }, { status: 409 });

  // 1. id lists (cheap, parallel)
  const [createdIds, owedIds, recipientTabs] = await Promise.all([
    getBillIdsForSplitterOnchain(myWallet),
    getBillIdsForParticipantOnchain(myWallet),
    listRecipientTabsOnchain(myWallet),
  ]);

  // 2. per-bill detail (batched)
  const created: CreatedBill[] = await Promise.all(
    createdIds.map(async (billId) => {
      const [bill, preimage] = await Promise.all([
        getBillOnchain(billId),
        getOnchainBillPreimage(REGISTRY_ADDRESS, billId.toString()),
      ]);
      const participants = await Promise.all(
        bill.participantList.map(async (addr) => {
          const p = await getParticipantOnchain(billId, addr as `0x${string}`);
          return { addr: addr.toLowerCase(), owed: p.owed, paid: p.paid };
        }),
      );
      return {
        billId,
        totalOwed: bill.totalOwed,
        totalPaid: bill.totalPaid,
        claimed: bill.claimed,
        participants,
        labels: preimage?.participantLabels ?? [],
        providers: preimage?.participantProviders ?? [],
        createdAtSeconds: preimage?.createdAtSeconds ?? 0,
      };
    }),
  );

  const owed: OwedBill[] = await Promise.all(
    owedIds.map(async (billId) => {
      const [p, preimage] = await Promise.all([
        getParticipantOnchain(billId, myWallet),
        getOnchainBillPreimage(REGISTRY_ADDRESS, billId.toString()),
      ]);
      // ponytail: no preimage → createdAtSeconds 0 bins into 30d+ aging. Fine for v1.
      return { billId, myOwed: p.owed, myPaid: p.paid, createdAtSeconds: preimage?.createdAtSeconds ?? 0 };
    }),
  );

  // 3. reputation + shortfalls
  const reputationSummary = await getReputationSummary(myWallet);
  const shortfallCountByTab: Record<string, number> = {}; // ponytail: fill from SettlementShortfall logs in Task 7 if needed

  const data = buildDashboard({
    nowSeconds: Math.floor(Date.now() / 1000),
    myWallet,
    created,
    owed,
    recipientTabs,
    shortfallCountByTab,
    reputation: {
      avgScore: reputationSummary.avgScore ?? 0, // getReputationSummary returns null for no history
      count: reputationSummary.count,
      lateCount: reputationSummary.lateCount,
      points: [], // ponytail: point series in Task 7
    },
  });
  return Response.json(data);
}
