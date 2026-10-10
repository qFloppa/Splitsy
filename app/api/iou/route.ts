import { getBillsOnchain, getBillPaymentsOnchain } from "@/lib/arc-read";
import { archiveRows, archiveTotals } from "@/lib/iou-archive";
import { getDepositStanding, insertIou, listIousForWallets } from "@/lib/iou-journal-repo";
import { getSessionUser } from "@/lib/session";
import { getSlotWalletsForUser } from "@/lib/pending-wallets-repo";
import { getUsersByWallets } from "@/lib/users-repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The IOU tab's archive, and the journal write behind it.
//
// ONE ROUTE, TWO METHODS, because they are two halves of one thing: GET assembles
// what has landed, POST records a statement the client just made real. The write
// has to exist because half of an IOU is invisible on chain — "I owe X" is a bare
// USDC transfer with nothing attached, so the chain cannot tell it apart from any
// other transfer out of the wallet, and the sentence would otherwise be lost.
//
// THE CLIENT SUPPLIES THE FACTS THE CHAIN CANNOT, AND ONLY THOSE. A POST body is
// untrusted, so nothing here decides anything on its word: the bill standing, the
// payment legs and the escrow deposit statuses are all re-read from Arc and from
// our own index. What the body carries is the sentence, the amount and the tx
// hash of a transaction that has ALREADY settled — and the worst a forged body
// can do is write a row about someone else's landed transaction under the
// caller's own wallet, which is a self-inflicted lie about their own history.
//
// The signer address is taken from the SESSION, never the body, so one user
// cannot write rows into another's archive.

const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
const KIND = new Set(["ask", "settle"]);
const STATUS = new Set(["open", "escrowed"]);

// The route's own wallet set, mirroring app/api/dashboard's parseWallets: the
// session wallet plus any the client names (a non-custodial user has no social
// session, and a dual-identity user's browser-wallet IOUs would be invisible), plus
// the SLOT, which the client cannot know about. Signature-only — every wallet here
// is an address whose PUBLIC history is being read.
function parseWallets(url: URL, sessionWallet: string | null, extra: string[] = []): string[] {
  const raw = (url.searchParams.get("wallets") ?? "").split(",");
  const fromQuery = raw.map((w) => w.trim().toLowerCase()).filter((w) => ADDR_RE.test(w));
  const base = fromQuery.length > 0 ? fromQuery : sessionWallet ? [sessionWallet.toLowerCase()] : [];
  const all = [...base, ...extra.map((w) => w.trim().toLowerCase()).filter((w) => ADDR_RE.test(w))];
  return [...new Set(all)];
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const user = await getSessionUser();
  const slots = user ? await getSlotWalletsForUser(user).catch(() => []) : [];
  const wallets = parseWallets(url, user?.wallet_address ?? null, slots.map((s) => s.wallet_address));
  if (wallets.length === 0) return Response.json({ rows: [], settledUsd: 0, count: 0 });

  let journal;
  try {
    journal = await listIousForWallets(wallets);
  } catch (err) {
    // A failed read is not an empty archive. Same call the wallet-history route
    // makes: answer the shape, say it was unreadable, and log the reason server-side.
    console.error("[iou] journal read failed:", err instanceof Error ? err.message : err);
    return Response.json({ rows: [], settledUsd: 0, count: 0, unreadable: true });
  }
  if (journal.length === 0) return Response.json({ rows: [], settledUsd: 0, count: 0 });

  // The chain half: standing + payment legs for every bill the journal names.
  // Both go through the same registry, so the ids are read together.
  const billIds = [...new Set(journal.filter((j) => j.kind === "ask" && j.billId).map((j) => j.billId!))];
  const bigIds = billIds.map((id) => BigInt(id));
  const [bills, payments, deposits] = await Promise.all([
    getBillsOnchain(bigIds).catch(() => []),
    getBillPaymentsOnchain(bigIds).catch(() => new Map()),
    getDepositStanding(
      journal
        .filter((j) => j.escrowAddress && j.escrowDepositId)
        .map((j) => ({ escrowAddress: j.escrowAddress!, depositId: j.escrowDepositId! })),
    ).catch(() => new Map()),
  ]);

  const standing = new Map<string, { totalOwed: bigint; totalPaid: bigint }>();
  // The counterparty of an ask is on chain, in the bill the journal names: an
  // IOU bill has exactly one participant, and that participant is the debtor.
  // Worth reading off here because the journal's own counterparty_address is
  // null for every ask written before the composer started sending it — without
  // this the oldest half of the archive could never be tagged.
  const askCounterparties = new Map<string, string>();
  bills.forEach((bill, i) => {
    // A null is an unreadable bill, not an unpaid one — left out entirely, which
    // lib/iou-archive reads as silence and keeps out of the archive.
    if (!bill) return;
    standing.set(billIds[i], { totalOwed: bill.totalOwed, totalPaid: bill.totalPaid });
    if (bill.participantList.length === 1) askCounterparties.set(billIds[i], bill.participantList[0]);
  });

  // Who those addresses are. Display-only enrichment over the same lookup the
  // pay page and the settle deck use, and it answers with an empty map rather
  // than throwing — a Supabase hiccup costs handles, not the archive.
  const addresses = journal.map((j) => j.counterpartyAddress ?? (j.billId ? askCounterparties.get(j.billId) : null));
  const people = await getUsersByWallets(addresses.filter((a): a is string => Boolean(a)));

  // The resolved address is written back onto the row, so the archive can both
  // tag the person and link the tag to their wallet on Arc.
  const resolved = journal.map((j, i) => ({ ...j, counterpartyAddress: addresses[i] ?? null }));

  const rows = archiveRows({ journal: resolved, bills: standing, payments, deposits, people });
  const totals = archiveTotals(rows);
  return Response.json({ rows, settledUsd: totals.settledUsd, count: totals.count });
}

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return Response.json({ error: "Invalid JSON body" }, { status: 400 });

  // The signer comes from the SESSION. A browser-wallet-only user has no social
  // session, so `wallet` is the address they name — validated as an address and
  // used only to scope a read back.
  const signerAddress =
    user.provider === "wallet" && typeof body.signerAddress === "string" && ADDR_RE.test(body.signerAddress)
      ? body.signerAddress.toLowerCase()
      : (user.wallet_address ?? "").toLowerCase();
  if (!signerAddress) return Response.json({ error: "No wallet to record this against." }, { status: 400 });

  const kind = String(body.kind ?? "");
  const status = String(body.status ?? "open");
  if (!KIND.has(kind)) return Response.json({ error: "Unknown IOU kind." }, { status: 400 });
  if (!STATUS.has(status)) return Response.json({ error: "Unknown IOU status." }, { status: 400 });

  const label = String(body.counterpartyLabel ?? "").trim();
  const amount = Number(body.amountUsd);
  if (!label || !Number.isFinite(amount) || amount <= 0) {
    return Response.json({ error: "An IOU needs a counterparty and a positive amount." }, { status: 400 });
  }

  const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  const txHash = str(body.txHash);
  if (txHash && !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return Response.json({ error: "That is not a transaction hash." }, { status: 400 });
  }

  // THE IDS ARE VALIDATED BECAUSE THEY ARE LATER INTERPOLATED INTO A QUERY.
  // getDepositStanding builds a PostgREST `or(...)` filter out of
  // (escrow_address, deposit_id) — there is no tuple IN — so a deposit id carrying
  // filter syntax would be read back as filter syntax on the NEXT archive load.
  // The round trip through our own table is what makes this easy to miss: these
  // values look like ours by then, and they came from a request body. The repo
  // drops malformed pairs too, so rows already in the table are covered.
  //
  // Both ids are uint256 decimal strings and both addresses are 0x40, so the
  // narrow shape is also the correct one. Rejected rather than stripped: a
  // malformed id is a client bug, and silently writing a row that can never
  // resolve is worse than saying so.
  const UINT256 = /^[0-9]{1,78}$/;
  const billId = str(body.billId);
  const escrowDepositId = str(body.escrowDepositId);
  const registryAddress = str(body.registryAddress);
  const escrowAddress = str(body.escrowAddress);
  const counterpartyAddress = str(body.counterpartyAddress);
  const malformed =
    (billId && !UINT256.test(billId) && "bill id") ||
    (escrowDepositId && !UINT256.test(escrowDepositId) && "deposit id") ||
    (registryAddress && !ADDR_RE.test(registryAddress) && "registry address") ||
    (escrowAddress && !ADDR_RE.test(escrowAddress) && "escrow address") ||
    (counterpartyAddress && !ADDR_RE.test(counterpartyAddress) && "counterparty address");
  if (malformed) return Response.json({ error: `That is not a valid ${malformed}.` }, { status: 400 });

  const ok = await insertIou({
    signerAddress,
    kind: kind as "ask" | "settle",
    counterpartyLabel: label,
    counterpartyAddress,
    amountUsdc: amount.toFixed(6),
    note: String(body.note ?? "").slice(0, 200),
    status: status as "open" | "escrowed",
    registryAddress,
    billId,
    escrowAddress,
    escrowDepositId,
    txHash,
  });

  // A MISS IS NOT A FAILED IOU. The money has already moved — the client only
  // calls this after the rail reported success — so this answers 200 with
  // `recorded: false` and lets the client say so in one sentence. A non-2xx here
  // would invite a retry of a payment that has already happened.
  return Response.json({ recorded: ok });
}