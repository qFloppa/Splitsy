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
import { getReputationSummaryForWallets } from "@/lib/reputation-repo";
import { buildDashboard, type CreatedBill, type OwedBill } from "@/lib/dashboard-aggregate";
import { DEMO_DASHBOARD } from "@/lib/dashboard-fixture";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

// Every read below is PUBLIC on-chain data (registry bills, participants,
// recurring tabs) or the public reputation mirror — the browser already reads
// the same via viem elsewhere. So the endpoint accepts explicit wallet
// address(es) to scope to: a non-custodial user has no social session, and a
// dual-identity user's browser-wallet bills would otherwise be invisible. The
// session wallet is only a fallback when the client sends no address.
function parseWallets(url: URL, sessionWallet: string | null): `0x${string}`[] {
  const raw = (url.searchParams.get("wallets") ?? "").split(",");
  const fromQuery = raw.map((w) => w.trim().toLowerCase()).filter((w) => ADDR_RE.test(w));
  const all = fromQuery.length > 0 ? fromQuery : sessionWallet ? [sessionWallet.toLowerCase()] : [];
  return [...new Set(all)] as `0x${string}`[];
}

// A tab where the user is recipient from more than one of their wallets should
// appear once. Keyed by tab address.
function dedupeTabs<T extends { address: string }>(tabs: T[]): T[] {
  const seen = new Map<string, T>();
  for (const t of tabs) {
    const key = t.address.toLowerCase();
    if (!seen.has(key)) seen.set(key, t);
  }
  return [...seen.values()];
}

// Orchestration over already-tested parts (reads → buildDashboard). bigint never
// crosses Response.json — buildDashboard returns strings/numbers only.
export async function GET(request: Request) {
  const url = new URL(request.url);

  // Demo/empty-state preview: static fixture, NO chain/DB read.
  if (url.searchParams.get("demo") === "1") {
    return Response.json(DEMO_DASHBOARD);
  }

  const user = await getSessionUser();
  const wallets = parseWallets(url, user?.wallet_address ?? null);
  if (wallets.length === 0) {
    // No social session AND no wallet supplied → nothing to scope to.
    return Response.json({ error: "No wallet to report on" }, { status: 400 });
  }

  // 1. id lists per wallet (cheap, parallel). Union the created/owed id sets
  //    across wallets, deduping so a bill reachable from two of the user's
  //    wallets is read (and counted) exactly once.
  const perWallet = await Promise.all(
    wallets.map(async (w) => {
      const [splitterIds, participantIds, tabs] = await Promise.all([
        getBillIdsForSplitterOnchain(w),
        getBillIdsForParticipantOnchain(w),
        listRecipientTabsOnchain(w),
      ]);
      return { wallet: w, splitterIds, participantIds, tabs };
    }),
  );

  const createdIds = [...new Set(perWallet.flatMap((p) => p.splitterIds.map((id) => id.toString())))];
  // An owed bill is scoped to the wallet that owes it — remember which wallet so
  // getParticipant reads the right participant row. First wallet wins if a bill
  // is owed by two of the user's wallets (avoids double-counting one debt).
  const owedPairs = new Map<string, `0x${string}`>();
  for (const p of perWallet) {
    for (const id of p.participantIds) {
      const key = id.toString();
      if (!owedPairs.has(key)) owedPairs.set(key, p.wallet);
    }
  }
  const recipientTabs = dedupeTabs(perWallet.flatMap((p) => p.tabs));

  // 2. per-bill detail (batched)
  const created: CreatedBill[] = await Promise.all(
    createdIds.map(async (idStr) => {
      const billId = BigInt(idStr);
      const [bill, preimage] = await Promise.all([
        getBillOnchain(billId),
        getOnchainBillPreimage(REGISTRY_ADDRESS, idStr),
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
    [...owedPairs.entries()].map(async ([idStr, wallet]) => {
      const billId = BigInt(idStr);
      const [p, preimage] = await Promise.all([
        getParticipantOnchain(billId, wallet),
        getOnchainBillPreimage(REGISTRY_ADDRESS, idStr),
      ]);
      // ponytail: no preimage → createdAtSeconds 0 bins into 30d+ aging. Fine for v1.
      return { billId, myOwed: p.owed, myPaid: p.paid, createdAtSeconds: preimage?.createdAtSeconds ?? 0 };
    }),
  );

  // 3. reputation across all of the user's wallets + shortfalls
  const reputationSummary = await getReputationSummaryForWallets(wallets);
  const shortfallCountByTab: Record<string, number> = {}; // ponytail: fill from SettlementShortfall logs if needed

  const data = buildDashboard({
    nowSeconds: Math.floor(Date.now() / 1000),
    myWallet: wallets[0],
    created,
    owed,
    recipientTabs,
    shortfallCountByTab,
    reputation: {
      avgScore: reputationSummary.avgScore ?? 0, // null for no history
      count: reputationSummary.count,
      lateCount: reputationSummary.lateCount,
      points: [], // ponytail: point series if needed
    },
  });
  return Response.json(data);
}
