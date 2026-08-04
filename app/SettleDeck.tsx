"use client";

import { useMemo } from "react";
import { billUnitsToUsdc } from "@/lib/bill-split-contracts";
import { buildSettleItems, type OwnedDebt, type SettleItem, type SocialDebt } from "@/lib/settle-items";

export type SettleDeckProps = {
  socialDebts: SocialDebt[];
  walletDebts: OwnedDebt[];
  splitterBills: OwnedDebt[];
  nowSeconds: bigint;
};

const usd = (units: bigint) => `$${billUnitsToUsdc(units)}`;

export default function SettleDeck({ socialDebts, walletDebts, splitterBills, nowSeconds }: SettleDeckProps) {
  const items = useMemo(
    () => buildSettleItems({ socialDebts, walletDebts, splitterBills, nowSeconds }),
    [socialDebts, walletDebts, splitterBills, nowSeconds],
  );
  // The rail counts payable items only — the divider and end card are chrome.
  // Ids, not items: `.filter` narrows the element type, so indexOf on the array
  // itself would reject a plain SettleItem.
  const countedIds = items.filter((item) => item.kind !== "divider" && item.kind !== "end").map((item) => item.id);

  return (
    <div className="settle-deck">
      {items.map((item) => (
        <Section key={item.id} item={item} index={countedIds.indexOf(item.id)} total={countedIds.length} />
      ))}
    </div>
  );
}

function Section({ item, index, total }: { item: SettleItem; index: number; total: number }) {
  if (item.kind === "divider") {
    return (
      <section className="settle-divider" data-active="true">
        <p className="settle-label">owed to you</p>
        <hr />
        <p className="settle-merchant" style={{ fontSize: "clamp(2rem, 1rem + 3vw, 4rem)", margin: 0 }}>
          {item.claimCount} bill{item.claimCount === 1 ? "" : "s"} · ${item.totalUsd.toFixed(2)}
        </p>
      </section>
    );
  }

  if (item.kind === "end") {
    return (
      <section className="settle-section" data-active="true">
        <h2 className="settle-merchant">nothing waiting on you</h2>
        <p className="settle-meta">Bills tagged to your handle or wallet will appear here.</p>
      </section>
    );
  }

  return (
    <section className="settle-section" data-active="true">
      {/* A lone item gets no counter — snap chrome on a single card is noise. */}
      <div className="settle-rail">
        <span>{total > 1 ? `${String(index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}` : ""}</span>
        <span>arc testnet</span>
      </div>
      <SectionBody item={item} />
    </section>
  );
}

function SectionBody({ item }: { item: Exclude<SettleItem, { kind: "divider" } | { kind: "end" }> }) {
  if (item.kind === "debt-social") {
    return (
      <>
        <p className="settle-label">
          to {item.debt.creator?.handle ?? "the creator"}
          {item.debt.creator?.provider ? ` · ${item.debt.creator.provider}` : ""}
        </p>
        <h2 className="settle-merchant">{item.debt.merchant}</h2>
        <p className="settle-label">you pay</p>
        <p className="settle-amount">${item.debt.amountUsd.toFixed(2)}</p>
        <p className="settle-meta">settles in full from your splitsy wallet</p>
      </>
    );
  }

  if (item.kind === "claim-failed") {
    return (
      <>
        <p className="settle-label">bill #{item.debt.billId.toString()}</p>
        <h2 className="settle-merchant">this bill didn&apos;t come together</h2>
        <p className="settle-meta">
          It held the money until everyone paid, and the due date passed while still short. There is nothing to
          collect — each payer takes their own share back.
        </p>
      </>
    );
  }

  if (item.kind === "claim") {
    return (
      <>
        <p className="settle-label">bill #{item.debt.billId.toString()}</p>
        <h2 className="settle-merchant">ready to collect</h2>
        <p className="settle-label">you collect</p>
        <p className="settle-amount">{usd(item.debt.claimable)}</p>
        <span className="settle-rule" />
        <p className="settle-meta">
          paid {usd(item.debt.totalPaid)} · claimed {usd(item.debt.claimed)}
        </p>
      </>
    );
  }

  const { debt, action, refundable } = item;
  return (
    <>
      <p className="settle-label">bill #{debt.billId.toString()}</p>
      {/* Placeholder heading: the merchant name comes from useBillVerification,
          wired in by the next task. */}
      <h2 className="settle-merchant">Bill #{debt.billId.toString()}</h2>
      <p className="settle-label">{action === "refund" ? "you get back" : "you pay"}</p>
      <p className="settle-amount">{usd(action === "refund" ? refundable : debt.remaining)}</p>
      <span className="settle-rule" />
      <p className="settle-meta">
        {action === "refund"
          ? "this bill didn't come together — your share goes back to your wallet"
          : `of ${usd(debt.owed)} owed${debt.dueDate > 0n ? ` · due ${new Date(Number(debt.dueDate) * 1000).toLocaleDateString()}` : ""}`}
      </p>
    </>
  );
}
