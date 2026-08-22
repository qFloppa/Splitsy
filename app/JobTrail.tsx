"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { PosterFact } from "./SpecCard";

// The expandable half of a decision-log row: every transaction of the ERC-8183
// ceremony, the live getJob read behind it, and the x402 payment that gated it.
//
// Set in the poster's voice, like the row it opens under (see
// app/SettlementAgentsPanel.tsx): the summary is a caps label and a figure, the
// contract facts are the same labelled cells a rail of figures uses, and each
// transaction is one receipt line. Nothing draws a box.
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
    <details className="bill-items" onToggle={(e) => e.currentTarget.open && load()}>
      <summary>
        <span className="settle-label">
          job #{jobId} · {detail?.job?.statusName ?? jobStatus ?? "unknown"}
          {loading ? " · reading the chain…" : ""}
        </span>
        <span className="bill-items-total">
          {feeUsdc.toFixed(3)} fee
          <ChevronDown className="bill-items-chevron" size={16} />
        </span>
      </summary>

      {error ? (
        <p className="bill-poster-msg" data-tone="error" role="status">
          {error}
        </p>
      ) : null}

      {detail?.job ? (
        <>
          <p className="bill-options-hint">
            {detail.job.description} — read live off the chain by{" "}
            <span className="mono">getJob({detail.jobId})</span>, not from a cache.
          </p>
          <div className="bill-poster-rail">
            {(["client", "provider", "evaluator"] as const).map((role) => (
              <PosterFact
                key={role}
                label={`${role} · ${ROLES[role]}`}
                value={
                  <a
                    className="iou-row-tx"
                    href={`${EXPLORER}/address/${detail.job?.[role]}`}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {short(detail.job?.[role] ?? "")}
                  </a>
                }
              />
            ))}
            <PosterFact
              label="escrow · released on complete"
              value={`${detail.job.budgetUsdc.toFixed(3)} USDC`}
            />
            <PosterFact
              label="status · live, from the chain"
              value={`${detail.job.statusName} (${detail.job.status})`}
            />
            <PosterFact label="expires · unclaimed escrow returns" value={formatDate(detail.job.expiredAt)} />
          </div>
        </>
      ) : null}

      {rows.length > 0 ? (
        <>
          <p className="bill-options-hint">The ceremony — one transaction per call, in the order they ran.</p>
          {rows.map((row, i) => (
            <div className="bill-item" key={`${row.step}-${row.txHash}-${i}`}>
              <i>{String(i + 1).padStart(2, "0")}</i>
              <span>
                {row.step}
                {row.blockNumber === null ? " · the settlement" : ` · block ${row.blockNumber}`}
              </span>
              <a
                className="iou-row-tx"
                href={`${EXPLORER}/tx/${row.txHash}`}
                rel="noreferrer"
                target="_blank"
              >
                {short(row.txHash)}
              </a>
            </div>
          ))}
        </>
      ) : null}

      {detail && rows.length === 0 && !error ? (
        <p className="bill-options-hint">
          No transactions found for this job — the settlement hash it is anchored on has not been recorded yet.
        </p>
      ) : null}

      {detail?.payments.length ? (
        <>
          <p className="bill-options-hint">x402 — what the agents paid each other to get this settled.</p>
          {detail.payments.map((p) => (
            <div className="bill-item" key={`${p.gatewayTx}-${p.direction}`}>
              <i>{p.direction === "earned" ? "+" : "−"}</i>
              <span>
                {p.endpoint} · {p.amountUsdc.toFixed(3)} USDC
              </span>
              <PaymentLink gatewayTx={p.gatewayTx} />
            </div>
          ))}
        </>
      ) : null}
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
  if (!gatewayTx) return <span className="iou-row-tx">no receipt id</span>;
  return (
    <a
      className="iou-row-tx"
      href={gatewayReceiptUrl(gatewayTx)}
      rel="noreferrer"
      target="_blank"
      title="Circle's receipt for this batched x402 payment"
    >
      {gatewayTx.slice(0, 8)}…
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
