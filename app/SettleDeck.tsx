"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useMemo, useState, type ReactNode } from "react";
import { billUnitsToUsdc } from "@/lib/bill-split-contracts";
import { buildSettleItems, type OwnedDebt, type SettleItem, type SocialDebt } from "@/lib/settle-items";
import { bridgeSourceChains, type BridgeSourceChain } from "@/lib/appkit-bridge";
import { useBillVerification } from "./BillVerification";
import type { BillRunState, ProgressFlow } from "./HomeClient";

// The handlers and shared state every section reads. Bundled rather than
// threaded one prop at a time — four kinds of section want overlapping subsets
// of it, and the list only grows.
export type SettleDeckHandlers = {
  billState: BillRunState;
  partialPayments: Record<string, string>;
  setPartialPayments: (value: Record<string, string>) => void;
  claimAmounts: Record<string, string>;
  setClaimAmounts: (value: Record<string, string>) => void;
  debtMessages: Record<string, { message: string; tone: "error" | "neutral" | "success" }>;
  payDebtOnArc: (debt: OwnedDebt) => void;
  claimSplitterFunds: (debt: OwnedDebt) => void;
  refundOnArc: (debt: OwnedDebt) => void;
  paySocialDebt: (debt: SocialDebt) => void;
  bridgeForDebt: (debt: OwnedDebt, source: BridgeSourceChain) => void;
  progressFlow: ProgressFlow | null;
};

export type SettleDeckProps = SettleDeckHandlers & {
  socialDebts: SocialDebt[];
  walletDebts: OwnedDebt[];
  splitterBills: OwnedDebt[];
  nowSeconds: bigint;
  // Either identity counts. Without one the deck is empty for a reason worth
  // saying out loud, rather than the "all clear" the end card otherwise reads as.
  signedIn: boolean;
};

const usd = (units: bigint) => `$${billUnitsToUsdc(units)}`;

export default function SettleDeck({
  socialDebts,
  walletDebts,
  splitterBills,
  nowSeconds,
  signedIn,
  ...deck
}: SettleDeckProps) {
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
        <Section
          deck={deck}
          index={countedIds.indexOf(item.id)}
          item={item}
          key={item.id}
          signedIn={signedIn}
          total={countedIds.length}
        />
      ))}
    </div>
  );
}

function Section({
  deck,
  index,
  item,
  signedIn,
  total,
}: {
  deck: SettleDeckHandlers;
  index: number;
  item: SettleItem;
  signedIn: boolean;
  total: number;
}) {
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
        <h2 className="settle-merchant">{signedIn ? "nothing waiting on you" : "sign in to settle"}</h2>
        <p className="settle-meta">
          {signedIn
            ? "Bills tagged to your handle or wallet will appear here."
            : "Sign in or connect a wallet to see the bills tagged to you."}
        </p>
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
      {item.kind === "debt-social" ? (
        <SocialDebtBody deck={deck} item={item} />
      ) : item.kind === "debt-wallet" ? (
        <WalletDebtBody deck={deck} item={item} />
      ) : item.kind === "claim" ? (
        <ClaimBody deck={deck} item={item} />
      ) : (
        <FailedClaimBody item={item} />
      )}
    </section>
  );
}

type ItemOf<K extends SettleItem["kind"]> = Extract<SettleItem, { kind: K }>;

// One shared message line, so an error from any path lands in the same place.
function DeckMessage({ deck, id }: { deck: SettleDeckHandlers; id: string }) {
  const message = deck.debtMessages[id];
  if (!message) return null;
  return (
    <p className="settle-meta" style={message.tone === "error" ? { color: "var(--warning-text)" } : undefined}>
      {message.message}
    </p>
  );
}

function SocialDebtBody({ deck, item }: { deck: SettleDeckHandlers; item: ItemOf<"debt-social"> }) {
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
      <button
        className="settle-action"
        disabled={deck.billState === "working"}
        onClick={() => deck.paySocialDebt(item.debt)}
        type="button"
      >
        Pay →
      </button>
      <DeckMessage deck={deck} id={item.id} />
    </>
  );
}

function WalletDebtBody({ deck, item }: { deck: SettleDeckHandlers; item: ItemOf<"debt-wallet"> }) {
  const { debt, action, refundable } = item;
  const verification = useBillVerification(debt.billId, debt.metadataHash);
  const merchant = verification.merchant || `Bill #${debt.billId.toString()}`;
  // A mismatch or an altered total is a red warning, not a detail — it opens
  // itself rather than waiting behind a click, because Pay is right there.
  const unsafe = verification.status === "mismatch" || verification.audit.state === "altered";
  // null = follow the warning; an explicit open or close pins it. Same shape as
  // BillVerification's receipt toggle, and it needs no effect to do it.
  const [sheet, setSheet] = useState<"verified" | "bridge" | "none" | null>(null);
  const openSheet = sheet ?? (unsafe ? "verified" : "none");
  // Client-side guard only — the contract clamps regardless. Saying so before
  // the signature costs one comparison and saves a rejected transaction.
  const remainingLabel = billUnitsToUsdc(debt.remaining);
  const typed = Number(deck.partialPayments[item.id] ?? remainingLabel);
  const overpaying = action === "pay" && Number.isFinite(typed) && typed > Number(remainingLabel);
  const editing = item.editable && action === "pay";
  // A partly-paid all-or-nothing bill before its deadline: the money is
  // committed but is not yet the creator's, and saying so is the whole point.
  const heldInEscrow = debt.escrowUntilFull && debt.totalPaid < debt.totalOwed && refundable === 0n && debt.paid > 0n;

  return (
    <>
      <p className="settle-label">bill #{debt.billId.toString()}</p>
      <h2 className="settle-merchant">{merchant}</h2>
      <p className="settle-label">{action === "refund" ? "you get back" : "you pay"}</p>
      {editing ? (
        <>
          <input
            aria-label={`Amount to pay on bill ${debt.billId.toString()}`}
            className="settle-amount"
            inputMode="decimal"
            onChange={(event) => deck.setPartialPayments({ ...deck.partialPayments, [item.id]: event.target.value })}
            type="number"
            value={deck.partialPayments[item.id] ?? remainingLabel}
          />
          <span className="settle-rule" data-tone={overpaying ? "warning" : undefined} />
        </>
      ) : (
        <>
          <p className="settle-amount">{usd(action === "refund" ? refundable : debt.remaining)}</p>
          <span className="settle-rule" />
        </>
      )}
      <p className="settle-meta">
        {action === "refund"
          ? "this bill didn't come together — your share goes back to your wallet"
          : heldInEscrow
            ? `your ${usd(debt.paid)} is in the bill, not with the creator — they can't collect until the group is paid up${
                debt.dueDate > 0n
                  ? `, and you can take yours back after ${new Date(Number(debt.dueDate) * 1000).toLocaleDateString()}`
                  : ""
              }`
            : `of ${usd(debt.owed)} owed${
                debt.dueDate > 0n ? ` · due ${new Date(Number(debt.dueDate) * 1000).toLocaleDateString()}` : ""
              }`}
      </p>
      {!item.editable && action === "pay" ? (
        <p className="settle-meta">settles in full from your splitsy wallet</p>
      ) : null}
      <button
        className="settle-action"
        disabled={deck.billState === "working" || overpaying}
        onClick={() => (action === "refund" ? deck.refundOnArc(debt) : deck.payDebtOnArc(debt))}
        type="button"
      >
        {action === "refund" ? "Get it back" : "Pay"} →
      </button>
      {overpaying ? (
        <p className="settle-meta" style={{ color: "var(--warning-text)" }}>
          more than the {usd(debt.remaining)} remaining
        </p>
      ) : null}
      <DeckMessage deck={deck} id={item.id} />

      <div className="settle-triggers">
        <button
          className="settle-trigger"
          data-tone={unsafe ? "warning" : undefined}
          onClick={() => setSheet("verified")}
          type="button"
        >
          {verification.status === "loading" ? "checking…" : unsafe ? "⌃ doesn't match arc" : "⌃ verified on arc"}
        </button>
        {/* Bridging pays from the browser wallet; a Circle-wallet debt has
            nothing to bridge into. */}
        {item.editable ? (
          <button className="settle-trigger" onClick={() => setSheet("bridge")} type="button">
            ⌃ bridge
          </button>
        ) : null}
      </div>

      <Sheet
        onClose={() => setSheet("none")}
        open={openSheet === "verified"}
        title={unsafe ? `warning — ${merchant}` : `verified on arc — ${merchant}`}
      >
        <VerifiedSheetBody metadataHash={debt.metadataHash} verification={verification} />
      </Sheet>

      <Sheet onClose={() => setSheet("none")} open={openSheet === "bridge"} title="bring usdc to arc">
        <p className="settle-meta">
          Your USDC is on another chain. CCTP V2 burns it there and mints it on Arc in three transactions — approve,
          bridge, then claim. After it lands, pay the debt here.
        </p>
        <div style={{ display: "grid", gap: "0.4rem", marginTop: "1.4rem" }}>
          {bridgeSourceChains.map((chain) => (
            <button
              className="settle-action"
              disabled={deck.billState === "working"}
              key={chain.id}
              onClick={() => {
                setSheet("none");
                deck.bridgeForDebt(debt, chain.id);
              }}
              style={{ fontSize: "clamp(1.3rem, 0.9rem + 1.4vw, 2rem)", margin: 0 }}
              type="button"
            >
              {chain.label} →
            </button>
          ))}
        </div>
      </Sheet>
    </>
  );
}

// A viewport-fixed slide-up. Radix owns the portal (a fixed child of a scaled
// .settle-section would otherwise position against the section, not the
// viewport), the focus trap, Escape, outside-click, and focus return.
// ponytail: no close-on-scroll — a modal blocks the scroll it would react to.
function Sheet({
  children,
  onClose,
  open,
  title,
}: {
  children: ReactNode;
  onClose: () => void;
  open: boolean;
  title: string;
}) {
  return (
    <Dialog.Root
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      open={open}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="settle-sheet-backdrop" />
        <Dialog.Content aria-describedby={undefined} className="settle-sheet">
          <Dialog.Title className="settle-label">{title}</Dialog.Title>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// The same two checks the inline panel renders, in the poster's voice.
function VerifiedSheetBody({
  metadataHash,
  verification,
}: {
  metadataHash: `0x${string}`;
  verification: ReturnType<typeof useBillVerification>;
}) {
  const { status, receiptUrl, dueDate, audit } = verification;

  if (status === "loading") {
    return <p className="settle-meta">Checking this bill against Arc…</p>;
  }
  if (status === "unpublished" || status === "error") {
    return (
      <p className="settle-meta">
        {status === "unpublished"
          ? "On-chain verification isn’t available for this bill."
          : "Couldn’t reach the verifier — refresh to retry."}
      </p>
    );
  }

  const verified = status === "verified";
  return (
    <div style={{ display: "grid", gap: "0.9rem", marginTop: "1.2rem" }}>
      <p className="settle-meta" style={verified ? undefined : { color: "var(--warning-text)" }}>
        {verified
          ? "Genuine bill on Arc — the merchant, total, and split shown here are exactly what the creator committed, and can’t have been edited since."
          : "The details don’t match what was committed on Arc. Don’t pay until the creator re-checks this bill."}
      </p>

      {verified && dueDate ? (
        <p className="settle-meta">
          Pay by {new Date(dueDate * 1000).toLocaleDateString()} to keep your on-chain payment reputation strong.
        </p>
      ) : null}

      {verified ? (
        <p className="settle-meta" style={audit.state === "altered" ? { color: "var(--warning-text)" } : undefined}>
          {audit.state === "checking"
            ? "Checking the total against the receipt…"
            : audit.state === "ok"
              ? `Total matches the receipt (~$${audit.onchainUsd.toFixed(2)}).`
              : audit.state === "altered"
                ? `Total was changed — the receipt reads about $${audit.scannedUsd.toFixed(2)}, but you’re charged $${audit.onchainUsd.toFixed(2)}. Ask the creator before paying.`
                : audit.state === "no-receipt"
                  ? "No receipt was uploaded — the creator typed this total by hand, so it can’t be checked against a bill."
                  : "Couldn’t re-read the total automatically — compare the receipt below yourself."}
        </p>
      ) : null}

      {verified && receiptUrl ? (
        <a href={receiptUrl} rel="noreferrer" target="_blank">
          {/* Plain img: a Supabase Storage URL isn't in next.config's allowed domains. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            alt="Receipt committed on-chain for this bill"
            src={receiptUrl}
            style={{
              border: "1px solid var(--pay-poster-rule)",
              borderRadius: "0.6rem",
              maxHeight: "18rem",
              width: "auto",
            }}
          />
        </a>
      ) : null}

      <p className="settle-meta" style={{ fontFamily: "var(--font-geist-mono)", overflowWrap: "anywhere" }}>
        {metadataHash}
      </p>
    </div>
  );
}

function ClaimBody({ deck, item }: { deck: SettleDeckHandlers; item: ItemOf<"claim"> }) {
  const { debt } = item;
  const claimableLabel = billUnitsToUsdc(debt.claimable);
  const typed = Number(deck.claimAmounts[item.id] ?? claimableLabel);
  const overclaiming = Number.isFinite(typed) && typed > Number(claimableLabel);

  return (
    <>
      <p className="settle-label">bill #{debt.billId.toString()}</p>
      <h2 className="settle-merchant">ready to collect</h2>
      <p className="settle-label">you collect</p>
      {item.editable ? (
        <>
          <input
            aria-label={`Amount to collect from bill ${debt.billId.toString()}`}
            className="settle-amount"
            inputMode="decimal"
            onChange={(event) => deck.setClaimAmounts({ ...deck.claimAmounts, [item.id]: event.target.value })}
            type="number"
            value={deck.claimAmounts[item.id] ?? claimableLabel}
          />
          <span className="settle-rule" data-tone={overclaiming ? "warning" : undefined} />
        </>
      ) : (
        <>
          <p className="settle-amount">{usd(debt.claimable)}</p>
          <span className="settle-rule" />
        </>
      )}
      <p className="settle-meta">
        paid {usd(debt.totalPaid)} · claimed {usd(debt.claimed)}
      </p>
      {!item.editable ? <p className="settle-meta">collects in full to your splitsy wallet</p> : null}
      <button
        className="settle-action"
        disabled={deck.billState === "working" || overclaiming}
        onClick={() => deck.claimSplitterFunds(debt)}
        type="button"
      >
        Collect →
      </button>
      {overclaiming ? (
        <p className="settle-meta" style={{ color: "var(--warning-text)" }}>
          more than the {usd(debt.claimable)} ready
        </p>
      ) : null}
      <DeckMessage deck={deck} id={item.id} />
    </>
  );
}

function FailedClaimBody({ item }: { item: ItemOf<"claim-failed"> }) {
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
