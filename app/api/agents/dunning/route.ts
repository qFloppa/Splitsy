// The creditor-side agent, run on a cron. For every bill a Splitsy user created
// that carries a due date and still has an unpaid share, it nudges, escalates,
// or — where the debtor granted a per-bill mandate — pulls the overdue amount.
//
// Cadence honesty: this runs once a day at 12:00 UTC (vercel.json), because
// Vercel Hobby refuses to deploy any cron that fires more than daily. That is
// NOT "the moment it's due"; a debt due at 13:00 waits ~23 hours. "Within a
// day" is the granularity to claim. Six-hourly needs a Pro plan; per-bill
// timing would be a different mechanism entirely.
//
// Reach: email only. The X and Discord OAuth scopes here are signin-only and the
// DM APIs are gated, so a "nudge" is an email or nothing.
import {
  claimDunningAction,
  listDunningActions,
  setDunningTx,
} from "@/lib/agents-repo";
import {
  getBillIdsForSplitterOnchain,
  getBillsOnchain,
  getCollectibleOnchain,
  getCollectMandateOnchain,
  getParticipantsOnchain,
  REGISTRY_ADDRESS,
} from "@/lib/arc-read";
import { executeContract } from "@/lib/wallet-provider";
import { decideDunning, type DunningAction } from "@/lib/dunning";
import { encodeCollectDebt } from "@/lib/registry-calldata";
import { createSupabaseServerClient } from "@/lib/supabase";
import { getUsersByWallets } from "@/lib/users-repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Expected outcomes of a sweep, not failures — the same distinction
// app/api/recurring/settle draws with its own ignorable list. A debtor who
// revoked their mandate between the read and the send is normal; anything else
// fails the run loudly.
const ignorableCollectErrors = new Set(["NotYetDue", "NoCollectMandate", "NothingCollectible"]);

type Outcome = {
  billId: string;
  debtor: string;
  action: DunningAction;
  reason: string;
  amountUsdc?: number;
  txHash?: string;
};

export async function GET(request: Request) {
  return sweep(request);
}

export async function POST(request: Request) {
  return sweep(request);
}

async function sweep(request: Request) {
  const denied = authorize(request);
  if (denied) return denied;

  const creditors = await listCreditorWallets();
  const now = Math.floor(Date.now() / 1000);
  const outcomes: Outcome[] = [];

  for (const creditor of creditors) {
    const billIds = await getBillIdsForSplitterOnchain(creditor.wallet).catch(() => []);
    if (billIds.length === 0) continue;

    const bills = await getBillsOnchain([...billIds]);

    for (const bill of bills) {
      // No deadline means nothing to escalate toward — decideDunning would say
      // the same, but skipping here saves a per-participant fan-out.
      if (!bill || bill.dueDate === 0n) continue;
      if (bill.totalPaid >= bill.totalOwed) continue;

      const parts = await getParticipantsOnchain(
        bill.participantList.map((addr) => ({ billId: bill.billId, addr })),
      );

      for (const [i, debtor] of bill.participantList.entries()) {
        const p = parts[i];
        if (!p?.exists) continue;
        const remaining = p.owed - p.paid;
        if (remaining <= 0n) continue;

        const outcome = await handleDebtor({ creditor, billId: bill.billId, dueDate: Number(bill.dueDate), debtor, remaining, now });
        if (outcome) outcomes.push(outcome);
      }
    }
  }

  return Response.json({ ok: true, checked: creditors.length, outcomes });
}

async function handleDebtor(input: {
  creditor: { userId: string; wallet: `0x${string}`; walletId: string };
  billId: bigint;
  dueDate: number;
  debtor: `0x${string}`;
  remaining: bigint;
  now: number;
}): Promise<Outcome | null> {
  const { billId, debtor } = input;
  const billKey = billId.toString();

  const [hasMandate, alreadyLogged] = await Promise.all([
    getCollectMandateOnchain(billId, debtor).catch(() => false),
    listDunningActions(REGISTRY_ADDRESS, billKey, debtor),
  ]);

  // Ask the contract what a collection would actually move rather than
  // simulating a revert. 0 when there is no mandate, it is not yet due, or the
  // debtor's allowance/balance leave nothing.
  const collectible = hasMandate ? await getCollectibleOnchain(billId, debtor).catch(() => 0n) : 0n;

  const decision = decideDunning(
    { dueDate: input.dueDate, remaining: input.remaining, hasMandate, collectible, alreadyLogged },
    input.now,
  );
  if (decision.action === "none") return null;

  // Claim BEFORE acting. For nudge/escalate the partial unique index is what
  // stops a cron overlap from mailing the same person twice; a lost race means
  // another run already owns it.
  const claimed = await claimDunningAction({
    registryAddress: REGISTRY_ADDRESS,
    billId: billKey,
    debtorAddress: debtor,
    action: decision.action,
    reason: decision.reason,
    amountUsdc: Number(decision.amount) / 1e6,
  });
  if (!claimed) return null;

  if (decision.action === "collect") {
    try {
      const tx = await executeContract(
        input.creditor.walletId,
        REGISTRY_ADDRESS,
        encodeCollectDebt(billId, debtor, decision.amount),
      );
      if (tx.txHash) await setDunningTx(REGISTRY_ADDRESS, billKey, debtor, "collect", tx.txHash);
      // Reputation is deliberately NOT recorded for a pull. Being auto-debited
      // at a deadline is not the same signal as choosing to pay on time, and
      // scoring it as one would corrupt the average. The DebtPaid the pull
      // emits is scored by the existing monitor as the payment it is; nothing
      // extra is claimed about the debtor's intent.
      return {
        billId: billKey,
        debtor,
        action: "collect",
        reason: decision.reason,
        amountUsdc: Number(decision.amount) / 1e6,
        txHash: tx.txHash ?? undefined,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if ([...ignorableCollectErrors].some((name) => message.includes(name))) {
        console.log(`dunning: bill ${billKey} debtor ${debtor} not collectible right now — ${message}`);
        return { billId: billKey, debtor, action: "collect", reason: "not_collectible" };
      }
      throw err;
    }
  }

  const sent = await sendDunningEmail({
    debtor,
    billId: billKey,
    action: decision.action,
    amountUsdc: Number(input.remaining) / 1e6,
  });

  return {
    billId: billKey,
    debtor,
    action: decision.action,
    reason: sent ? decision.reason : "email_unconfigured",
  };
}

// Every user with a provisioned wallet is a potential creditor. Reading the
// bill ids from chain per wallet is the authoritative list — a bill created
// outside Splitsy still shows up.
async function listCreditorWallets(): Promise<{ userId: string; wallet: `0x${string}`; walletId: string }[]> {
  const client = createSupabaseServerClient();
  if (!client) return [];

  const { data, error } = await client
    .from("users")
    .select("id, wallet_address, circle_wallet_id")
    .not("wallet_address", "is", null)
    .not("circle_wallet_id", "is", null);
  if (error) throw new Error(`Failed to list creditor wallets: ${error.message}`);

  return (data ?? []).map((r) => {
    const row = r as { id: string; wallet_address: string; circle_wallet_id: string };
    return {
      userId: String(row.id),
      wallet: row.wallet_address.toLowerCase() as `0x${string}`,
      walletId: row.circle_wallet_id,
    };
  });
}

// Resend, same as the sign-in code path. Returns false rather than throwing
// when email is unconfigured: a missing RESEND_API_KEY must not fail the sweep,
// it just means the nudge could not go out — which the log then records.
async function sendDunningEmail(input: {
  debtor: string;
  billId: string;
  action: DunningAction;
  amountUsdc: number;
}): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) return false;

  const owners = await getUsersByWallets([input.debtor]);
  const owner = owners.get(input.debtor.toLowerCase());
  // Email-provider users have their address as the handle; everyone else has a
  // social handle we cannot mail. No address, no nudge.
  if (!owner || owner.provider !== "email" || !owner.handle.includes("@")) return false;

  const overdue = input.action === "escalate";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({
      from,
      to: [owner.handle],
      subject: overdue
        ? `Overdue: $${input.amountUsdc.toFixed(2)} on Splitsy bill #${input.billId}`
        : `Due soon: $${input.amountUsdc.toFixed(2)} on Splitsy bill #${input.billId}`,
      text: overdue
        ? `Your $${input.amountUsdc.toFixed(2)} share of Splitsy bill #${input.billId} is past its due date. Open Splitsy to settle it.`
        : `Your $${input.amountUsdc.toFixed(2)} share of Splitsy bill #${input.billId} is due in a few days. Open Splitsy to settle it.`,
    }),
  });

  if (!res.ok) {
    console.error(`dunning: Resend send failed (${res.status}) for bill ${input.billId}`);
    return false;
  }
  return true;
}

function authorize(request: Request) {
  const secret = process.env.AGENT_SECRET ?? process.env.CRON_SECRET;
  if (!secret) {
    return Response.json({ error: "Missing AGENT_SECRET or CRON_SECRET on the server." }, { status: 500 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized dunning request." }, { status: 401 });
  }
  return null;
}
