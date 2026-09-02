// "Settle net" for the Circle wallet identity: approve, pay the outstanding
// debts the user selected, and claim every funded bill — as ONE atomic on-chain
// transaction.
//
// Splitsy's social wallets are Circle SCA accounts (lib/circle-dcw.ts), which
// expose executeBatch on the wallet's own address. Atomicity is the point: one
// reverting leg reverts everything, so there is no half-settled state to report
// or unwind. See https://developers.circle.com/wallets/batch-operations.md
//
// Since registry v2 the batch is just TWO calls: one approve, then one
// settle(claimIds, payIds, amounts) that carries every leg. The registry itself
// runs the claims before the pays, so claim proceeds fund the pay legs inside
// the same transaction.
//
// Note this does NOT move less USDC — registry accounting binds each debt to its
// billId, so every debt still gets its own pay leg. What collapses is the
// transaction count: 2N+M calls become 2.
//
// The body selects WHICH legs run (so a bogus bill can be left unpaid); it never
// carries an amount. Every amount is read from chain.
import { cookies } from "next/headers";
import { after } from "next/server";
import { getSessionUser } from "@/lib/session";
import { verifyWalletUnlock, WALLET_UNLOCK_COOKIE } from "@/lib/session-core";
import { encodeApprove, encodeExecuteBatch, encodeSettle } from "@/lib/registry-calldata";
import { executeContract, InsufficientFundsError } from "@/lib/wallet-provider";
import {
  REGISTRY_ADDRESS,
  getBillIdsForParticipantOnchain,
  getBillIdsForSplitterOnchain,
  getBillsOnchain,
  getParticipantsOnchain,
  getUsdcBalanceOnchain,
} from "@/lib/arc-read";
import { recordPaidFeedbackSafely } from "@/lib/erc8004";
import { claimableNow, shouldPayLeg } from "@/lib/treasury";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ARC_USDC_ADDRESS = process.env.ARC_TESTNET_USDC_ADDRESS ?? "0x3600000000000000000000000000000000000000";

const usdc = (v: bigint) => (Number(v) / 1e6).toString();

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });

  const secret = process.env.SESSION_SECRET ?? "";
  const unlockToken = (await cookies()).get(WALLET_UNLOCK_COOKIE)?.value ?? "";
  if (verifyWalletUnlock(unlockToken, secret, Date.now()) !== user.id) {
    return Response.json({ error: "locked" }, { status: 403 });
  }
  if (!user.circle_wallet_id || !user.wallet_address) {
    return Response.json({ error: "Your wallet isn't provisioned yet. Log in again." }, { status: 409 });
  }
  const wallet = user.wallet_address as `0x${string}`;
  const walletId = user.circle_wallet_id;
  const me = wallet.toLowerCase();

  // Selection. Absent/malformed body = settle everything, which keeps the
  // one-click path working. `counterparties` is a whitelist of addresses to pay,
  // so unticking a bogus bill's creator simply drops its legs from the batch.
  const body: unknown = await request.json().catch(() => null);
  const raw = (body ?? {}) as { counterparties?: unknown; collect?: unknown };
  const selected = Array.isArray(raw.counterparties)
    ? new Set(raw.counterparties.map((a) => String(a).toLowerCase()))
    : null; // null = every counterparty
  const collect = raw.collect !== false;

  // 1. Derive every leg from chain.
  const [owedIds, createdIds] = await Promise.all([
    getBillIdsForParticipantOnchain(wallet),
    getBillIdsForSplitterOnchain(wallet),
  ]);
  // Owed bills are read twice over: getParticipant for my remaining share, and
  // getBill for the splitter — the counterparty the selection names.
  const [parts, owedBills, createdBills] = await Promise.all([
    getParticipantsOnchain(owedIds.map((billId) => ({ billId, addr: wallet }))),
    getBillsOnchain([...owedIds]),
    getBillsOnchain([...createdIds]),
  ]);

  const payLegs = owedIds.flatMap((billId, i) => {
    const p = parts[i];
    const splitter = owedBills[i]?.splitter;
    // Unreadable bill: we cannot say whose debt this is, so it cannot be
    // matched against the selection. Skip rather than pay a nameless leg.
    if (!p || !splitter) return [];
    const remaining = p.owed - p.paid;
    if (!shouldPayLeg({ splitter, remaining }, me, selected)) return [];
    return [{ billId, amount: remaining }];
  });
  // claimableNow, not a raw (totalPaid - claimed), because an escrowUntilFull
  // bill reverts its claim leg until everyone has paid — and settle is atomic,
  // so one escrowed bill would take the whole batch down. A short escrowed bill
  // past its deadline has failed and never becomes claimable; its money leaves
  // through the payers' refund, not through here.
  const claimLegs = collect
    ? createdBills.flatMap((b) => {
        if (!b) return [];
        const claimable = claimableNow(b);
        return claimable > 0n ? [{ billId: b.billId, amount: claimable }] : [];
      })
    : [];

  if (payLegs.length === 0 && claimLegs.length === 0) {
    const narrowed = selected !== null || !collect;
    return Response.json(
      { error: narrowed ? "Nothing selected is still outstanding." : "Nothing to settle." },
      { status: 409 },
    );
  }

  // 2. Build the batch: approve, then one settle carrying every leg. The
  //    approval must precede the settle that spends it; the claim-before-pay
  //    ordering is the registry's own, so it no longer has to be arranged here.
  const total = payLegs.reduce((s, l) => s + l.amount, 0n);
  const calls: { to: string; data: `0x${string}` }[] = [];
  if (total > 0n) {
    calls.push({ to: ARC_USDC_ADDRESS, data: encodeApprove(REGISTRY_ADDRESS, total) });
  }
  calls.push({
    to: REGISTRY_ADDRESS,
    data: encodeSettle(
      claimLegs.map((l) => l.billId),
      payLegs.map((l) => l.billId),
      payLegs.map((l) => l.amount),
    ),
  });

  // 2b. Short wallet? Say so now. Circle reports an on-chain revert as a bare
  //     "execution failed", which reads as a bug rather than as an empty wallet.
  //     Claims count toward the budget because they execute first in the same
  //     atomic transaction. Gas is USDC on Arc too, so a wallet that clears this
  //     by a hair can still fail — this catches the honest shortfall, not a
  //     rounding one.
  if (total > 0n) {
    const claimTotal = claimLegs.reduce((s, l) => s + l.amount, 0n);
    const budget = (await getUsdcBalanceOnchain(wallet)) + claimTotal;
    if (budget < total) {
      return Response.json(
        { error: "insufficient_funds", neededUsdc: usdc(total), availableUsdc: usdc(budget) },
        { status: 402 },
      );
    }
  }

  // 3. One atomic transaction, sent to the wallet's OWN address (that is where
  //    executeBatch lives on an SCA account).
  let tx: { txHash: string | null };
  try {
    tx = await executeContract(walletId, wallet, encodeExecuteBatch(calls));
  } catch (err) {
    if (err instanceof InsufficientFundsError) {
      return Response.json({ error: "insufficient_funds" }, { status: 402 });
    }
    // Atomic: nothing settled, so report the whole thing as failed.
    return Response.json(
      { error: err instanceof Error ? err.message : "Settlement failed" },
      { status: 502 },
    );
  }

  // Same consent rule as the per-bill pay route: paying a full remaining share
  // is what permits ERC-8004 scoring. Deferred so the extra txs never delay this
  // response, and never turn a settled batch into an error.
  if (tx.txHash) {
    const paymentTxHash = tx.txHash;
    for (const leg of payLegs) {
      const billId = leg.billId.toString();
      after(() => recordPaidFeedbackSafely({ payerAddress: wallet, payerWalletId: walletId, billId, paymentTxHash }));
    }
  }

  return Response.json({
    ok: true,
    txHash: tx.txHash,
    paid: payLegs.map((l) => ({ billId: l.billId.toString(), amountUsdc: usdc(l.amount) })),
    claimed: claimLegs.map((l) => ({ billId: l.billId.toString(), amountUsdc: usdc(l.amount) })),
  });
}
