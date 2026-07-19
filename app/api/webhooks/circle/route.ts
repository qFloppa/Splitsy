import { after } from "next/server";
import { verifyCircleSignature, type CircleNotification } from "@/lib/circle-webhook";
import { confirmDebtPaidByTxId, revertDebtByTxId, recordWebhookEvent } from "@/lib/bills-repo";
import { parseDebtPaidLog, recordExternalPaidFeedbackSafely } from "@/lib/erc8004";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Circle Notification API v2 subscriber (Programmable Wallets + Smart Contract
// Platform event monitors). Public endpoint — Circle calls it, so auth is the
// ECDSA signature, not a session. Rules from Circle's delivery model:
//   - at-least-once: dedup on notificationId before side effects
//   - unordered: act on the state each notification carries, never on arrival
// Always 200 after verification so Circle doesn't retry events we simply
// don't consume; non-2xx is reserved for "retry this later".

const SETTLED = new Set(["COMPLETE", "CONFIRMED"]);
const DEAD = new Set(["FAILED", "DENIED", "CANCELLED"]);

export async function POST(request: Request) {
  // Raw body, untouched — parse only after the signature checks out.
  const rawBody = await request.text();
  const ok = await verifyCircleSignature(
    rawBody,
    request.headers.get("X-Circle-Key-Id"),
    request.headers.get("X-Circle-Signature"),
  );
  if (!ok) return Response.json({ error: "bad signature" }, { status: 401 });

  let event: CircleNotification;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "bad payload" }, { status: 400 });
  }

  // Console sends webhooks.test on registration; ack anything un-dedupable.
  if (!event.notificationId || !event.notificationType) return Response.json({ ok: true });

  const txId = event.notification?.id ?? null;
  const state = event.notification?.state ?? null;

  const fresh = await recordWebhookEvent({
    notificationId: event.notificationId,
    notificationType: event.notificationType,
    txId,
    txState: state,
  });
  if (!fresh) return Response.json({ ok: true, duplicate: true });

  // Outbound = debt settlements we initiated; match back to the debt by the
  // Circle tx id stored at initiation. Inbound (someone funding a Splitsy
  // wallet directly) has no debt to reconcile — logged by the dedup ledger,
  // nothing else to do yet.
  if (event.notificationType === "transactions.outbound" && txId && state) {
    if (SETTLED.has(state)) await confirmDebtPaidByTxId(txId);
    else if (DEAD.has(state)) await revertDebtByTxId(txId);
    // QUEUED/SENT/etc: intermediate states, nothing to change.
  }

  // SCP event monitor on BillSplitRegistry.DebtPaid. This is how browser /
  // non-custodial payments earn reputation — they settle on-chain directly and
  // never hit our pay route. Only paid-in-full settlements are scored, and only
  // the "paid_in_full" tag is positive per the consent policy. DCW payments
  // also emit DebtPaid and may arrive here too, but recordExternalPaidFeedback
  // is idempotent per (payer, bill), so whichever path records first wins.
  // Runs in after() so a slow chain of register + giveFeedback txs never holds
  // the webhook ack open (Circle would retry on a timeout).
  if (event.notificationType === "contracts.eventLog") {
    const log = parseDebtPaidLog(event.notification.topics ?? [], event.notification.data ?? "0x");
    const paymentTxHash = event.notification.txHash ?? null;
    // Diagnostic: one line that shows exactly how this event was interpreted.
    // decode=null → topics/data didn't match DebtPaid; paidInFull=false → a
    // partial payment (not scored); no txHash → nothing to anchor a score to.
    console.log(
      `reputation webhook: contracts.eventLog event=${event.notification.eventName ?? "?"} ` +
        `txHash=${paymentTxHash ?? "none"} decode=${log ? JSON.stringify(log) : "null"}`,
    );
    if (log && log.paidInFull && paymentTxHash) {
      console.log(`reputation webhook: scheduling score for payer ${log.payer} bill ${log.billId}`);
      after(() =>
        recordExternalPaidFeedbackSafely({
          payerAddress: log.payer,
          billId: log.billId,
          paymentTxHash,
        }),
      );
    } else {
      console.log(
        `reputation webhook: NOT scoring (paidInFull=${log?.paidInFull ?? "n/a"}, hasTxHash=${Boolean(paymentTxHash)})`,
      );
    }
  }

  return Response.json({ ok: true });
}

// Lets you sanity-check the deployed URL in a browser before registering it.
export async function GET() {
  return Response.json({ ok: true, endpoint: "circle-webhooks" });
}
