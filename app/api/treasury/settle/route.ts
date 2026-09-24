// "Settle net" for the social wallet identity: approve, pay the outstanding
// debts the user selected, and claim every funded bill.
//
// Since registry v2 that is just TWO calls: one approve, then one
// settle(claimIds, payIds, amounts) that carries every leg. The registry itself
// runs the claims before the pays, so claim proceeds fund the pay legs inside
// the same transaction.
//
// HOW THOSE TWO CALLS ARE SENT DEPENDS ON THE WALLET, and that is the only
// difference between the stacks here — see step 3. A Circle DCW is an SCA
// (lib/circle-dcw.ts) and takes both in one atomic executeBatch; a Privy wallet
// is a plain EOA and takes them one after the other.
//
// Note this does NOT move less USDC — registry accounting binds each debt to its
// billId, so every debt still gets its own pay leg. What collapses is the
// transaction count: 2N+M calls become 2, or 1 on an SCA.
//
// The body selects WHICH legs run (so a bogus bill can be left unpaid); it never
// carries an amount. Every amount is read from chain.
import { cookies } from "next/headers";
import { after } from "next/server";
import { getSessionUser } from "@/lib/session";
import { verifyWalletUnlock, WALLET_UNLOCK_COOKIE } from "@/lib/session-core";
import { encodeApprove, encodeExecuteBatch, encodeSettle } from "@/lib/registry-calldata";
import { userSignedLeg, type UserSignedBody } from "@/lib/user-signed";
import { executeContract, InsufficientFundsError, walletProviderName } from "@/lib/wallet-provider";
import {
  REGISTRY_ADDRESS,
  getBillIdsForParticipantOnchain,
  getBillIdsForSplitterOnchain,
  getBillsOnchain,
  getParticipantsOnchain,
  getUsdcAllowanceOnchain,
  getUsdcBalanceOnchain,
} from "@/lib/arc-read";
import { recordPaidFeedbackSafely } from "@/lib/erc8004";
import { claimableNow, shouldPayLeg } from "@/lib/treasury";
import { ARC } from "@/lib/arc-chain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ARC_USDC_ADDRESS = ARC.usdcAddress;

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

  // 2. Build the two calls: approve, then one settle carrying every leg. The
  //    approval must precede the settle that spends it; the claim-before-pay
  //    ordering is the registry's own, so it no longer has to be arranged here.
  const total = payLegs.reduce((s, l) => s + l.amount, 0n);
  const approveData = encodeApprove(REGISTRY_ADDRESS, total);
  const settleData = encodeSettle(
    claimLegs.map((l) => l.billId),
    payLegs.map((l) => l.billId),
    payLegs.map((l) => l.amount),
  );

  // 2b. Short wallet? Say so now. Circle reports an on-chain revert as a bare
  //     "execution failed", which reads as a bug rather than as an empty wallet.
  //     Claims count toward the budget because they execute first inside the same
  //     settle call. Gas is USDC on Arc too, so a wallet that clears this
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

  // 3. Send it. THE ONLY PLACE THE TWO WALLET STACKS DIFFER.
  //
  // A Circle DCW is an SCA, so both calls go out as ONE executeBatch sent to the
  // wallet's own address — all-or-nothing, nothing to unwind.
  //
  // A Privy wallet is a plain EOA and cannot do that. Not "does it badly":
  // an EOA does not revert on calldata it cannot run, it IGNORES it. Measured on
  // Arc rather than reasoned about — tx
  // 0x5870092926417f148363962be768594b7e555bfd7d7f6e8d82f1547b00dadf95 sent 324
  // bytes of executeBatch calldata to a Privy wallet's own address and came back
  // status success, 25290 gas, no logs, with the approve leg simply not done, which
  // receiptToState reads as "COMPLETE". So the EOA sends the two calls as two
  // transactions instead, and never builds a batch at all.
  //
  // WHAT THAT COSTS IS ONE EXTRA PROMPT, NOT THE SETTLEMENT'S ATOMICITY. settle()
  // is still a single call carrying every claim and every pay leg, claims first.
  // Only the approve stands outside it, and an approve that lands without its
  // settle leaves an unspent allowance — not a half-paid bill.
  const eoa = walletProviderName() === "privy";

  // WHICH LEG, decided by the chain rather than by the client — the same trick as
  // app/api/onchain-bills/[billId]/pay. When the user signs, each leg is its own
  // prepare/sign/relay round trip, because the second leg's nonce follows the
  // first. An allowance already covering the debt means the approve has mined and
  // settle is next. Re-read on every pass, so a browser that dies after the
  // approve resumes at settle, and one that retries the approve gets the settle it
  // actually needs.
  const leg: "approve" | "settle" =
    eoa && total > 0n && (await getUsdcAllowanceOnchain(wallet, REGISTRY_ADDRESS)) < total ? "approve" : "settle";

  // The wallet, the calldata, and what a ticket for it is allowed to be relayed
  // as. The context carries a digest of the legs — a settlement is many calls in
  // one transaction, so binding only the wallet would let a ticket for one plan
  // relay against a different one — and on an EOA the LEG as well, so an approve
  // ticket cannot be relayed as a settle or the other way round.
  const [to, data, context] = eoa
    ? ([
        leg === "approve" ? ARC_USDC_ADDRESS : REGISTRY_ADDRESS,
        leg === "approve" ? approveData : settleData,
        `settle:${leg}:${payLegs.length}:${claimLegs.length}:${total.toString()}`,
      ] as const)
    : ([
        wallet,
        encodeExecuteBatch([
          ...(total > 0n ? [{ to: ARC_USDC_ADDRESS, data: approveData }] : []),
          { to: REGISTRY_ADDRESS, data: settleData },
        ]),
        `settle:${total > 0n ? 2 : 1}:${total.toString()}`,
      ] as const);

  let tx: { txHash: string | null };
  try {
    // A claimed wallet signs its own settlement; the plan is re-derived from chain
    // on both passes.
    const signed = await userSignedLeg({
      body: (body ?? null) as UserSignedBody | null,
      walletId,
      userId: user.id,
      to,
      data,
      context,
    });
    if (signed && "response" in signed) return signed.response;

    if (signed) {
      // The approve landed. `more` brings the browser back, and the allowance read
      // above will hand it the settle. Nothing has been paid yet, so this answer
      // names no bills and queues no reputation.
      if (leg === "approve") return Response.json({ ok: true, txHash: signed.tx.txHash, more: true });
      tx = signed.tx;
    } else if (eoa) {
      // Server still holds the key: it can send both calls itself, in order, with
      // no round trip in between.
      if (total > 0n) await executeContract(walletId, ARC_USDC_ADDRESS, approveData);
      tx = await executeContract(walletId, REGISTRY_ADDRESS, settleData);
    } else {
      tx = await executeContract(walletId, wallet, data);
    }
  } catch (err) {
    if (err instanceof InsufficientFundsError) {
      return Response.json({ error: "insufficient_funds" }, { status: 402 });
    }
    // Nothing was paid: on the SCA the batch is atomic, and on the EOA a failure
    // is either the approve (which moves nothing) or the settle (which reverts
    // whole). Either way there is no partial settlement to report.
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
