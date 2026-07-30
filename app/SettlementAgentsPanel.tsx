"use client";

// The surface for the two settlement agents. Three numbered sections:
//   01. Autopay rules — the caps and checks that bind the debtor-side agent.
//   02. Collect mandates — per-bill permissions for the creditor-side agent,
//       each with a visible revoke.
//   03. The decision log — including every skip and its reason. The skips are the
//       point: they are what shows a spending mandate is still constrained.
//
// The "armed" styling on section 01 is load-bearing, not decorative: the lit
// rail and warmed header appear only while the agent is actually permitted to
// spend, so the page always answers "can software move my money right now?"
// from across the room.
//
// Distinct from app/AgentEconomyPanel.tsx, which is Scout's x402 nanopayment
// ledger. Same design tokens, different agents.
import { useCallback, useEffect, useState } from "react";
import { Ban, CalendarClock, Check, Loader2, ShieldCheck, X } from "lucide-react";

type Grant = {
  enabled: boolean;
  maxPerBillUsdc: number;
  maxPerDayUsdc: number;
  trustedCreators: string[];
  minCreatorScore: number;
  requireVerifiedHash: boolean;
};

type LogEntry = {
  billId: string;
  debtorAddress: string;
  decision: "pay" | "skip";
  reason: string;
  amountUsdc: number;
  txHash: string | null;
  createdAt: string;
};

type MandateBill = {
  billId: string;
  creatorLabel: string;
  remainingUsdc: string;
  dueDateSeconds: number;
  authorized: boolean;
};

// Every skip reason decideAutopay can return, in the user's words. An unmapped
// reason falls back to the raw slug rather than being hidden — a decision the
// user cannot read is worse than an ugly one.
const REASONS: Record<string, string> = {
  ok: "Paid",
  disabled: "Autopay is off",
  nothing_owed: "Already settled",
  over_bill_cap: "Above your per-bill cap",
  over_daily_cap: "Would breach your daily cap",
  untrusted_creator: "Creator is not on your list",
  low_creator_score: "Creator's score is below your floor",
  hash_mismatch: "Bill details did not match the chain",
  unverifiable: "No published details to verify",
  agent_out_of_funds: "The agent wallet is empty",
  agent_wallet_unavailable: "The agent wallet is unavailable",
  tx_failed: "The payment transaction failed",
};

export default function SettlementAgentsPanel() {
  const [grant, setGrant] = useState<Grant | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [mandates, setMandates] = useState<MandateBill[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"error" | "success">("success");
  const [pendingBillId, setPendingBillId] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);

  const load = useCallback(() => {
    fetch("/api/agents/grants")
      .then((r) => {
        // Rules are session-scoped, so a 401 is the normal signed-out state and
        // needs saying — on its own tab, returning nothing reads as a bug.
        setSignedOut(r.status === 401);
        return r.ok ? r.json() : null;
      })
      .then((d) => {
        if (!d) return;
        setGrant(d.grant as Grant);
        setLog((d.log ?? []) as LogEntry[]);
      })
      .catch(() => {});
    // Separate call because it reads the chain: a slow RPC must not delay the
    // rules form, which is pure database.
    fetch("/api/agents/mandate")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) setMandates((d.mandates ?? []) as MandateBill[]);
      })
      .catch(() => {});
  }, []);

  useEffect(load, [load]);

  function fail(text: string) {
    setMessageTone("error");
    setMessage(text);
  }

  async function save(next: Grant) {
    setGrant(next); // optimistic: the form must not feel like it dropped the edit
    setSaving(true);
    setMessage("");
    try {
      const res = await fetch("/api/agents/grants", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        fail(body.error ?? "Could not save your rules.");
        load(); // pull the server's truth back rather than leaving a lie on screen
        return;
      }
      setMessageTone("success");
      setMessage("Rules saved.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleMandate(billId: string, authorized: boolean) {
    setPendingBillId(billId);
    setMessage("");
    try {
      const res = await fetch("/api/agents/mandate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ billId, authorized }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        fail(
          body.error === "insufficient_funds"
            ? "Your wallet needs a little test USDC to cover the gas for this."
            : (body.error ?? "Could not update the mandate."),
        );
        return;
      }
      // Re-read rather than flipping locally: the mandate lives on chain, and
      // showing a permission state we have not confirmed is the one thing this
      // section must never do.
      load();
    } catch (err) {
      fail(err instanceof Error ? err.message : "Could not update the mandate.");
    } finally {
      setPendingBillId(null);
    }
  }

  if (signedOut) {
    return (
      <section className="spec-card">
        <div className="spec-head">
          <div className="min-w-0">
            <span className="spec-kicker">
              <span className="spec-icon">
                <ShieldCheck size={15} />
              </span>
              <span className="spec-step">Signed out</span>
            </span>
            <h3 className="spec-title">Nothing is authorized</h3>
            <p className="spec-note">
              Rules are tied to your account, so there is nothing to show until you sign in.
            </p>
          </div>
        </div>
        <div className="spec-body">
          <div className="spec-empty">
            <ShieldCheck size={22} />
            <span>
              <strong>No agent can spend on your behalf.</strong>
              <br />
              Sign in to set the caps and checks your settlement agents run under. Until you do, no permission exists to
              revoke.
            </span>
          </div>
        </div>
      </section>
    );
  }
  if (!grant) return null;

  const grantedCount = mandates.filter((m) => m.authorized).length;

  return (
    <div className="space-y-4">
      {saving || message ? (
        <div className={`message ${messageTone === "error" ? "message-error" : "message-neutral"}`}>
          {saving ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="animate-spin" size={13} /> Saving your rules…
            </span>
          ) : (
            message
          )}
        </div>
      ) : null}

      {/* ── 01. Autopay rules ── */}
      <section className={`spec-card ${grant.enabled ? "spec-card-live" : ""}`}>
        <div className="spec-head">
          <div className="min-w-0">
            <span className="spec-step">01 · Debtor side</span>
            <h3 className="spec-title">Autopay my share</h3>
            <p className="spec-note">
              When someone bills you, the agent pays from its own wallet — but only inside every rule below. Every
              rule is a ceiling, never a target.
            </p>
          </div>
          {/* The chip is the state, the switch is the control — no second
              "On/Off" caption repeating what the chip already says. */}
          <div className="flex shrink-0 items-center gap-3">
            <span className={`spec-chip ${grant.enabled ? "spec-chip-live" : ""}`}>
              <span className="spec-dot" />
              {grant.enabled ? "Armed" : "Idle"}
            </span>
            <Switch
              checked={grant.enabled}
              onChange={(enabled) => save({ ...grant, enabled })}
              size="lg"
              srLabel="Autopay my share"
            />
          </div>
        </div>

        <div className="spec-body space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <label>
              <span className="spec-label">Ceiling per bill</span>
              <span className="spec-input-wrap">
                <input
                  className="spec-input"
                  min={0}
                  onBlur={() => save(grant)}
                  onChange={(e) => setGrant({ ...grant, maxPerBillUsdc: Number(e.target.value) })}
                  step="0.01"
                  type="number"
                  value={grant.maxPerBillUsdc}
                />
                <span className="spec-input-unit">USDC</span>
              </span>
            </label>
            <label>
              <span className="spec-label">Ceiling per day</span>
              <span className="spec-input-wrap">
                <input
                  className="spec-input"
                  min={0}
                  onBlur={() => save(grant)}
                  onChange={(e) => setGrant({ ...grant, maxPerDayUsdc: Number(e.target.value) })}
                  step="0.01"
                  type="number"
                  value={grant.maxPerDayUsdc}
                />
                <span className="spec-input-unit">USDC</span>
              </span>
            </label>
            <label>
              <span className="spec-label">Creator score floor</span>
              <span className="spec-input-wrap">
                <input
                  className="spec-input"
                  max={100}
                  min={0}
                  onBlur={() => save(grant)}
                  onChange={(e) => setGrant({ ...grant, minCreatorScore: Number(e.target.value) })}
                  step={1}
                  type="number"
                  value={grant.minCreatorScore}
                />
                <span className="spec-input-unit">{grant.minCreatorScore === 0 ? "OFF" : "/ 100"}</span>
              </span>
              {/* Stated plainly because it is the one rule that fails open. */}
              <span className="spec-hint">A creator with no history yet still passes — no history is not a bad score.</span>
            </label>
          </div>

          <label className="block">
            <span className="spec-label">Allowed creators</span>
            <textarea
              className="spec-textarea"
              onBlur={() => save(grant)}
              onChange={(e) =>
                setGrant({
                  ...grant,
                  trustedCreators: e.target.value.split("\n").map((a) => a.trim()).filter(Boolean),
                })
              }
              placeholder="0x…  (one address per line)"
              rows={2}
              value={grant.trustedCreators.join("\n")}
            />
            <span className="spec-hint">
              {grant.trustedCreators.length === 0
                ? "Empty means any creator can trigger autopay, within the ceilings above."
                : `${grant.trustedCreators.length} address${grant.trustedCreators.length === 1 ? "" : "es"} — no one else can trigger autopay.`}
            </span>
          </label>

          <div className={`spec-row ${grant.requireVerifiedHash ? "spec-row-on" : ""}`}>
            <div className="min-w-0">
              <span className="inline-flex items-center gap-1.5 text-sm font-semibold">
                <ShieldCheck size={14} /> Only pay verified bills
              </span>
              <span className="spec-hint">
                The merchant, total and split must match what the creator committed on chain. Turn this off and the
                agent will pay bills it cannot check.
              </span>
            </div>
            <Switch
              checked={grant.requireVerifiedHash}
              onChange={(requireVerifiedHash) => save({ ...grant, requireVerifiedHash })}
              srLabel="Only pay verified bills"
            />
          </div>
        </div>
      </section>

      {/* ── 02. Collect mandates ── */}
      <section className="spec-card">
        <div className="spec-head">
          <div className="min-w-0">
            <span className="spec-step">02 · Creditor side</span>
            <h3 className="spec-title">Let creators collect after the due date</h3>
            {/* A consent UI that hides its scope is the actual security bug in
                this feature, so the scope is spelled out per bill below, not
                once in a footnote. */}
            <p className="spec-note">
              Granting this is per bill and you can withdraw it at any time. It never lets anyone take more than your
              remaining share, and never before the due date.
            </p>
          </div>
          {mandates.length > 0 ? (
            <span className={`spec-chip ${grantedCount > 0 ? "spec-chip-live" : ""}`}>
              <span className="spec-dot" />
              {grantedCount} of {mandates.length} granted
            </span>
          ) : null}
        </div>

        <div className="spec-body">
          {mandates.length === 0 ? (
            <div className="spec-empty">
              <CalendarClock size={22} />
              <span>
                <strong>No bills with a due date.</strong>
                <br />
                A mandate only makes sense once there is a deadline to collect after, so bills appear here as soon as
                one has a due date.
              </span>
            </div>
          ) : (
            <ul className="space-y-2">
              {mandates.map((bill) => (
                <li className={`spec-row ${bill.authorized ? "spec-row-on" : ""}`} key={bill.billId}>
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="spec-badge">#{bill.billId}</span>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold">{bill.creatorLabel}</div>
                      <div className="spec-hint">
                        After {formatDue(bill.dueDateSeconds)}, can pull up to{" "}
                        <span className="mono font-semibold">{bill.remainingUsdc} USDC</span> — your remaining share —
                        from your approved balance.
                      </div>
                    </div>
                  </div>
                  <button
                    className={bill.authorized ? "secondary-button" : "primary-button"}
                    disabled={pendingBillId === bill.billId}
                    onClick={() => toggleMandate(bill.billId, !bill.authorized)}
                    type="button"
                  >
                    {pendingBillId === bill.billId ? (
                      <Loader2 className="animate-spin" size={13} />
                    ) : bill.authorized ? (
                      <X size={13} />
                    ) : (
                      <Check size={13} />
                    )}
                    {bill.authorized ? "Revoke" : "Allow"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* ── 03. Decision log ── */}
      <section className="spec-card">
        <div className="spec-head">
          <div className="min-w-0">
            <span className="spec-step">03 · Audit trail</span>
            <h3 className="spec-title">What the agent decided</h3>
            <p className="spec-note">
              Every run, including the ones it declined. A skip and its reason is the proof the ceilings above are
              real.
            </p>
          </div>
          {log.length > 0 ? (
            <span className="spec-chip">
              {log.length} decision{log.length === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>

        <div className="spec-body">
          {log.length === 0 ? (
            <div className="spec-empty">
              <Ban size={22} />
              <span>
                <strong>No decisions yet.</strong>
                <br />
                The first time an agent looks at one of your bills, what it decided — and why — is written here.
              </span>
            </div>
          ) : (
            <ol>
              {log.map((entry) => (
                <li
                  className={`trail-row ${entry.decision === "pay" ? "trail-done" : ""}`}
                  key={`${entry.billId}-${entry.debtorAddress}`}
                >
                  <span className="trail-mark">
                    {entry.decision === "pay" ? <Check size={11} /> : <Ban size={11} />}
                  </span>
                  <span className="min-w-0">
                    <span className="text-sm font-semibold">Bill #{entry.billId}</span>
                    <span className="spec-hint">{REASONS[entry.reason] ?? entry.reason}</span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="trail-amount">
                      {entry.decision === "pay" ? `${entry.amountUsdc.toFixed(2)} USDC` : "no payment"}
                    </span>
                    <span className="spec-hint">{formatWhen(entry.createdAt)}</span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </section>
    </div>
  );
}

// A switch drawn from a real checkbox: the input keeps the native keyboard and
// screen-reader behaviour (space toggles, state is announced), and the track and
// knob are pure CSS off `peer-checked`. No JS state, nothing to desync.
function Switch({
  checked,
  onChange,
  size = "sm",
  srLabel,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  size?: "sm" | "lg";
  srLabel: string;
}) {
  const lg = size === "lg";
  return (
    <label className="inline-flex shrink-0 cursor-pointer select-none items-center gap-2">
      <input
        aria-label={srLabel}
        checked={checked}
        className="peer sr-only"
        onChange={(e) => onChange(e.target.checked)}
        type="checkbox"
      />
      <span
        className={`relative rounded-full bg-[var(--border-strong)] shadow-inner transition-colors duration-200
          after:absolute after:rounded-full after:bg-white after:shadow-[0_1px_3px_rgba(7,20,33,0.4)]
          after:transition-transform after:duration-200 after:ease-out after:content-['']
          peer-checked:bg-[var(--accent)]
          peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2
          peer-focus-visible:outline-[var(--accent)] peer-active:after:scale-95
          ${
            lg
              ? "h-7 w-[3.1rem] after:left-[4px] after:top-[4px] after:h-5 after:w-5 peer-checked:after:translate-x-[1.4rem]"
              : "h-[22px] w-10 after:left-[3px] after:top-[3px] after:h-4 after:w-4 peer-checked:after:translate-x-[18px]"
          }`}
      />
    </label>
  );
}

function formatDue(seconds: number) {
  if (!seconds) return "the due date";
  return new Date(seconds * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatWhen(iso: string) {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
