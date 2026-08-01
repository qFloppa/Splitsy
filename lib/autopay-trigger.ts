// Waking the debtor-side agent (app/api/agents/autopay/route.ts).
//
// Two callers, and BOTH are needed — this is the fix for a race that was silently
// costing every autopay its verified-hash check:
//
//   * The BillCreated webhook fires at mining time. But the creator can only
//     publish the bill's preimage AFTER the transaction lands, because the bill
//     id is assigned by the contract and has to be read back off chain first. So
//     the event reliably beats the preimage by a fraction of a second, and the
//     agent skipped with `unverifiable` on bills that were perfectly verifiable
//     a beat later.
//   * The preimage publishers fire once the row exists — but a bill created
//     outside Splitsy never gets one, and that case must still reach a logged
//     decision rather than silence.
//
// Whichever arrives first claims the log row; `claimAutopayDecision` lets the
// other re-decide it if the first only skipped for want of the preimage.
//
// Handing off over HTTP rather than importing the agent keeps it behind its own
// Bearer check: it spends money, so it stays independently authorized even when
// we are the caller.
//
// Fire-and-forget. Autopay declining, or being unconfigured, must never turn a
// delivered webhook into a retry or fail a bill that was already created.
export async function triggerAutopay(origin: string, billId: string) {
  const secret = process.env.AGENT_SECRET ?? process.env.CRON_SECRET;
  if (!secret) {
    console.log(`autopay trigger: no AGENT_SECRET/CRON_SECRET — skipping bill ${billId}`);
    return;
  }
  try {
    const res = await fetch(`${origin}/api/agents/autopay`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ billId }),
    });
    console.log(`autopay trigger: bill ${billId} -> ${res.status}`);
  } catch (err) {
    console.error(`autopay trigger: bill ${billId} failed:`, err instanceof Error ? err.message : err);
  }
}
