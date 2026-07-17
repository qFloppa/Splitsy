import { verifyCircleSignature, type CircleNotification } from "@/lib/circle-webhook";
import { confirmDebtPaidByTxId, revertDebtByTxId, recordWebhookEvent } from "@/lib/bills-repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Circle Notification API v2 subscriber (Programmable Wallets events).
// Public endpoint — Circle calls it, so auth is the ECDSA signature, not a
// session. Rules from Circle's delivery model:
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

  return Response.json({ ok: true });
}

// Lets you sanity-check the deployed URL in a browser before registering it.
export async function GET() {
  return Response.json({ ok: true, endpoint: "circle-webhooks" });
}
