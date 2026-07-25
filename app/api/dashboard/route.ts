import { getSessionUser } from "@/lib/session";
import {
  getBillIdsForSplitterOnchain,
  getBillIdsForParticipantOnchain,
  getBillsOnchain,
  getParticipantsOnchain,
  REGISTRY_ADDRESS,
} from "@/lib/arc-read";
import { listRecipientTabsForWalletsOnchain } from "@/lib/recurring-read";
import { getOnchainBillPreimages } from "@/lib/onchain-bill-preimage-repo";
import { getReputationSummaryForWallets } from "@/lib/reputation-repo";
import { buildDashboard, type CreatedBill, type OwedBill } from "@/lib/dashboard-aggregate";
import { DEMO_DASHBOARD } from "@/lib/dashboard-fixture";
import type { DashboardData } from "@/lib/dashboard-types";
import { buildTreasury, type TreasuryCreatedBill, type TreasuryOwedBill, type CounterpartyIdentity } from "@/lib/treasury";
import { getUsersByWallets } from "@/lib/users-repo";

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

  // 1. id lists per wallet + the recipient tabs, in parallel. Union the
  //    created/owed id sets across wallets, deduping so a bill reachable from
  //    two of the user's wallets is read (and counted) exactly once. Tabs are
  //    scanned ONCE for all wallets (deduped by tab) rather than per wallet.
  const [perWallet, recipientTabs] = await Promise.all([
    Promise.all(
      wallets.map(async (w) => {
        const [splitterIds, participantIds] = await Promise.all([
          getBillIdsForSplitterOnchain(w),
          getBillIdsForParticipantOnchain(w),
        ]);
        return { wallet: w, splitterIds, participantIds };
      }),
    ),
    listRecipientTabsForWalletsOnchain(wallets),
  ]);

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

  // 2. per-bill detail. Reads are collapsed into Multicall3 batches (one
  //    eth_call each) rather than one readContract per bill: a multi-wallet
  //    dashboard fans out to dozens of bills, and per-call reads overran the
  //    RPC's batch/rate limits (see getBillsOnchain). Preimages are Supabase
  //    reads (not RPC), so they stay a plain parallel fetch.
  const createdBigIds = createdIds.map((idStr) => BigInt(idStr));
  const bills = await getBillsOnchain(createdBigIds); // index-aligned with createdIds

  // Flatten every (bill, participant) into one multicall, remembering which
  // slice of the result belongs to which bill so we can reassemble below.
  const partPairs: { billId: bigint; addr: `0x${string}` }[] = [];
  const partSlots: number[][] = bills.map(() => []);
  bills.forEach((bill, bi) => {
    if (!bill) return;
    for (const addr of bill.participantList) {
      partSlots[bi].push(partPairs.length);
      partPairs.push({ billId: bill.billId, addr });
    }
  });
  const owedEntries = [...owedPairs.entries()];
  const allBillIds = [...new Set([...createdIds, ...owedEntries.map(([id]) => id)])];
  const [partResults, preimageMap] = await Promise.all([
    getParticipantsOnchain(partPairs),
    getOnchainBillPreimages(REGISTRY_ADDRESS, allBillIds),
  ]);

  const created: CreatedBill[] = [];
  bills.forEach((bill, bi) => {
    if (!bill) return; // getBill failed for this id — can't aggregate what we couldn't read
    const preimage = preimageMap.get(createdIds[bi]);
    const participants = bill.participantList.map((addr, k) => {
      const p = partResults[partSlots[bi][k]];
      return { addr: addr.toLowerCase(), owed: p?.owed ?? 0n, paid: p?.paid ?? 0n };
    });
    created.push({
      billId: bill.billId,
      totalOwed: bill.totalOwed,
      totalPaid: bill.totalPaid,
      claimed: bill.claimed,
      participants,
      labels: preimage?.participantLabels ?? [],
      providers: preimage?.participantProviders ?? [],
      createdAtSeconds: preimage?.createdAtSeconds ?? 0,
    });
  });

  // Owed bills need their splitter (the counterparty I owe) for the treasury
  // view, which getParticipant does not return — one more multicall, not a
  // per-bill fan-out (see getBillsOnchain on why per-call reads break the RPC).
  const [owedParts, owedBills] = await Promise.all([
    getParticipantsOnchain(owedEntries.map(([idStr, wallet]) => ({ billId: BigInt(idStr), addr: wallet }))),
    getBillsOnchain(owedEntries.map(([idStr]) => BigInt(idStr))),
  ]);
  const owed: OwedBill[] = owedEntries.map(([idStr], i) => {
    const p = owedParts[i];
    // ponytail: no preimage → createdAtSeconds 0 bins into 30d+ aging. Fine for v1.
    return {
      billId: BigInt(idStr),
      myOwed: p?.owed ?? 0n,
      myPaid: p?.paid ?? 0n,
      createdAtSeconds: preimageMap.get(idStr)?.createdAtSeconds ?? 0,
    };
  });

  // 3. reputation across all of the user's wallets + shortfalls
  const reputationSummary = await getReputationSummaryForWallets(wallets);
  const shortfallCountByTab: Record<string, number> = {}; // ponytail: fill from SettlementShortfall logs if needed

  // ── treasury: net position per counterparty ────────────────────────────────
  // Reuses the reads above; the only new I/O is the handle lookup below.
  const treasuryCreated: TreasuryCreatedBill[] = created.map((b) => ({
    billId: b.billId.toString(),
    totalPaid: b.totalPaid,
    claimed: b.claimed,
    participants: b.participants,
  }));
  const treasuryOwed: TreasuryOwedBill[] = owedEntries.flatMap(([idStr], i) => {
    const bill = owedBills[i];
    if (!bill) return []; // unreadable bill — can't name the counterparty, so skip it
    return [{
      billId: idStr,
      splitter: bill.splitter.toLowerCase(),
      myOwed: owed[i].myOwed,
      myPaid: owed[i].myPaid,
    }];
  });

  // Labels keyed LOWERCASE — buildTreasury lowercases chain addresses before
  // looking this map up, and chain reads return checksummed hex, so a mixed-case
  // key would silently fall back to the raw address / "unknown" bucket.
  // A preimage names the participants of a bill I created (index-aligned with
  // participantList, but possibly SHORTER on pre-migration rows — hence the
  // optional index); the users table names anyone with a social wallet. The users
  // row wins: it is the live handle, a preimage label is a creation-time snapshot.
  const identities: Record<string, CounterpartyIdentity> = {};
  bills.forEach((bill, bi) => {
    if (!bill) return;
    const preimage = preimageMap.get(createdIds[bi]);
    bill.participantList.forEach((addr, k) => {
      const label = preimage?.participantLabels?.[k];
      if (!label) return;
      const key = addr.toLowerCase();
      if (!identities[key]) identities[key] = { label, provider: preimage?.participantProviders?.[k] ?? null };
    });
  });
  const counterpartyAddresses = [
    ...treasuryCreated.flatMap((b) => b.participants.map((p) => p.addr)),
    ...treasuryOwed.map((b) => b.splitter),
  ];
  // Overwrites (not `if (!identities[key])`) so the live handle beats the snapshot.
  for (const [addr, user] of await getUsersByWallets(counterpartyAddresses)) {
    identities[addr.toLowerCase()] = { label: `@${user.handle}`, provider: user.provider };
  }

  const treasury = buildTreasury({
    myWallets: wallets, // every wallet the viewer controls, else own activity looks like a position
    created: treasuryCreated,
    owed: treasuryOwed,
    identities,
  });

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
  const response: DashboardData = { ...data, treasury };
  return Response.json(response);
}
