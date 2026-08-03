"use client";

import { useState } from "react";
import { ChevronRight, ExternalLink, Loader2 } from "lucide-react";

// The expandable half of a decision-log row: every transaction of the ERC-8183
// ceremony, the live getJob read behind it, and the x402 payment that gated it.
//
// Built on a real <details>, not a state-driven panel. The disclosure, the
// keyboard behaviour and the announced expanded/collapsed state are the
// browser's, so there is nothing here to desync — the same argument as Switch in
// app/SettlementAgentsPanel.tsx. The only state is the fetch, which happens once
// on first open: this endpoint reads the chain twice, and a page with a dozen
// settled bills must not do that a dozen times before anyone clicks.
const EXPLORER = "https://testnet.arcscan.app";

type Step = { step: string; blockNumber: number; txHash: string };

type Payment = {
  direction: "earned" | "spent";
  endpoint: string;
  amountUsdc: number;
  gatewayTx: string | null;
  createdAt: string;
};

type JobDetail = {
  jobId: string;
  settlementTx: string | null;
  feeUsdc: number;
  job: {
    client: string;
    provider: string;
    evaluator: string;
    description: string;
    budgetUsdc: number;
    expiredAt: number;
    status: number;
    statusName: string;
    hook: string;
  } | null;
  steps: Step[];
  payments: Payment[];
};

// Who each address is in this job. Fixed rather than looked up because
// encodeCreateJob names them in exactly this order on every call — the user's
// agent is always the client, the Settler always the provider, the Auditor
// always the evaluator. Three distinct wallets, so nobody grades their own work.
const ROLES: Record<string, string> = {
  client: "your agent",
  provider: "Splitsy Settler",
  evaluator: "Splitsy Auditor",
};

export default function JobTrail({
  billId,
  jobId,
  jobStatus,
  feeUsdc,
  connectedAddress,
}: {
  billId: string;
  jobId: string;
  jobStatus: string | null;
  feeUsdc: number;
  // Passed through to the read, and only so a row belonging to this browser's
  // OTHER account can expand: the endpoint authorises off the proof cookie, which
  // it will only honour for the wallet the extension is on. Nothing here is
  // trusted — a wrong or missing address just narrows what opens.
  connectedAddress?: string;
}) {
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Fetched at most once. A failed load leaves `error` set and `detail` null, so
  // re-opening retries — an RPC blip on the first click should not permanently
  // brick the row.
  function load() {
    if (detail || loading) return;
    setLoading(true);
    setError(null);
    fetch(
      `/api/agents/job?billId=${encodeURIComponent(billId)}${
        connectedAddress ? `&connected=${encodeURIComponent(connectedAddress)}` : ""
      }`,
    )
      .then(async (res) => {
        const body: unknown = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(
            (body as { error?: string } | null)?.error ?? "Could not read this job.",
          );
        }
        setDetail(body as JobDetail);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not read this job."))
      .finally(() => setLoading(false));
  }

  // The settlement is not an AgenticCommerce event, so it is not in `steps` —
  // but it is the payment the whole job attests to, and it always happens
  // between fund and submit (app/api/agents/autopay/route.ts runs them in that
  // fixed order). Spliced there rather than tacked on the end.
  const rows: Array<Step | { step: "payDebtFor"; blockNumber: null; txHash: string }> = [];
  for (const step of detail?.steps ?? []) {
    rows.push(step);
    if (step.step === "fund" && detail?.settlementTx) {
      rows.push({ step: "payDebtFor", blockNumber: null, txHash: detail.settlementTx });
    }
  }
  // No fund row to hang it off (a partial trail, or a window that missed it):
  // the settlement still has to be reachable.
  if (detail?.settlementTx && !rows.some((r) => r.txHash === detail.settlementTx)) {
    rows.push({ step: "payDebtFor", blockNumber: null, txHash: detail.settlementTx });
  }

  return (
    <details className="job-trail" onToggle={(e) => e.currentTarget.open && load()}>
      <summary className="spec-chip job-trail-summary">
        <ChevronRight className="job-trail-caret" size={12} />
        <span>
          job #{jobId} · {detail?.job?.statusName ?? jobStatus ?? "unknown"} · {feeUsdc.toFixed(3)} fee
        </span>
        {loading ? <Loader2 className="animate-spin" size={11} /> : null}
      </summary>

      <div className="job-trail-body">
        {error ? <p className="job-trail-error">{error}</p> : null}

        {detail?.job ? (
          <section>
            <h4 className="job-trail-head">
              contract read · <span className="mono">getJob({detail.jobId})</span>
            </h4>
            <p className="job-trail-desc">{detail.job.description}</p>
            <dl className="job-trail-facts">
              {(["client", "provider", "evaluator"] as const).map((role) => (
                <div key={role}>
                  <dt>{role}</dt>
                  <dd>
                    <a
                      className="mono"
                      href={`${EXPLORER}/address/${detail.job?.[role]}`}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {short(detail.job?.[role] ?? "")}
                    </a>
                    <span className="job-trail-role">{ROLES[role]}</span>
                  </dd>
                </div>
              ))}
              <div>
                <dt>escrow</dt>
                <dd>
                  <span className="mono">{detail.job.budgetUsdc.toFixed(3)} USDC</span>
                  <span className="job-trail-role">released on complete</span>
                </dd>
              </div>
              <div>
                <dt>status</dt>
                <dd>
                  <span className="mono">
                    {detail.job.statusName} ({detail.job.status})
                  </span>
                  <span className="job-trail-role">live, from the chain</span>
                </dd>
              </div>
              <div>
                <dt>expires</dt>
                <dd>
                  <span className="mono">{formatDate(detail.job.expiredAt)}</span>
                  <span className="job-trail-role">unclaimed escrow returns</span>
                </dd>
              </div>
            </dl>
          </section>
        ) : null}

        {rows.length > 0 ? (
          <section>
            <h4 className="job-trail-head">the ceremony · one transaction per call</h4>
            <ol className="job-trail-steps">
              {rows.map((row, i) => (
                <li key={`${row.step}-${row.txHash}-${i}`}>
                  <span className="job-trail-step">{row.step}</span>
                  <span className="job-trail-block">
                    {row.blockNumber === null ? "the settlement" : `#${row.blockNumber}`}
                  </span>
                  <a
                    className="job-trail-tx mono"
                    href={`${EXPLORER}/tx/${row.txHash}`}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {short(row.txHash)}
                    <ExternalLink size={10} />
                  </a>
                </li>
              ))}
            </ol>
          </section>
        ) : null}

        {detail && rows.length === 0 && !error ? (
          <p className="job-trail-error">
            No transactions found for this job — the settlement hash it is anchored on has not been
            recorded yet.
          </p>
        ) : null}

        {detail?.payments.length ? (
          <section>
            <h4 className="job-trail-head">x402 · what the agents paid each other</h4>
            <ul className="job-trail-pay">
              {detail.payments.map((p) => (
                <li key={`${p.gatewayTx}-${p.direction}`}>
                  <span className="job-trail-step">{p.endpoint}</span>
                  <span className="job-trail-block">
                    {p.direction} {p.amountUsdc.toFixed(3)} USDC
                  </span>
                  <PaymentLink gatewayTx={p.gatewayTx} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </details>
  );
}

// Circle's own record of one batched x402 payment: status, both addresses, the
// amount, and the txHash of the batch that settled it on chain.
//
// Note the /x402/ segment — the plain /v1/transfers/<id> route is a different
// namespace and 404s on these ids, which reads as "this payment never happened"
// rather than "wrong endpoint". The server-side twin is GATEWAY_TRANSFER_URL in
// lib/x402/constants.ts; this one is here so a client component can build the
// link without pulling that module's server env reads into the browser bundle.
export function gatewayReceiptUrl(transferId: string) {
  return `https://gateway-api-testnet.circle.com/v1/x402/transfers/${transferId}`;
}

// Exported because the Scout ledger links the same way. The id is only ever null
// for a payment whose settle() returned none, which would be a Gateway bug; the
// row still shows, without a link to nowhere.
export function PaymentLink({ gatewayTx }: { gatewayTx: string | null }) {
  if (!gatewayTx) return <span className="job-trail-tx mono">no receipt id</span>;
  return (
    <a
      className="job-trail-tx mono"
      href={gatewayReceiptUrl(gatewayTx)}
      rel="noreferrer"
      target="_blank"
      title="Circle's receipt for this batched x402 payment"
    >
      {gatewayTx.slice(0, 8)}…
      <ExternalLink size={10} />
    </a>
  );
}

function short(value: string) {
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

function formatDate(seconds: number) {
  if (!seconds) return "—";
  return new Date(seconds * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
