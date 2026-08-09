"use client";

import * as Dialog from "@radix-ui/react-dialog";
import confetti from "canvas-confetti";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { billUnitsToUsdc } from "@/lib/bill-split-contracts";
import {
  buildSettleItems,
  clearsSection,
  withHeldSections,
  type HeldSection,
  type OwnedDebt,
  type SettleItem,
  type SocialDebt,
} from "@/lib/settle-items";
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
  // The app header, rendered inside the deck's scroller so it scrolls away with
  // the first card. Outside it, it would stand over every section forever — the
  // deck is the only thing that scrolls on this tab.
  header: ReactNode;
  socialDebts: SocialDebt[];
  walletDebts: OwnedDebt[];
  splitterBills: OwnedDebt[];
  nowSeconds: bigint;
  // Either identity counts. Without one the deck is empty for a reason worth
  // saying out loud, rather than the "all clear" the end card otherwise reads as.
  signedIn: boolean;
};

const usd = (units: bigint) => `$${billUnitsToUsdc(units)}`;
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
// Whole percent of the group's total that has been paid in. Clamped because a
// bill can be overpaid, and a bar past 100% reads as a rendering bug.
const paidPercent = (paid: bigint, owed: bigint) =>
  owed <= 0n ? 0 : Math.min(100, Math.round((Number(paid) / Number(owed)) * 100));

function AsideRow({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="settle-aside-row">
      <span className="settle-label">{label}</span>
      <span className="settle-aside-value">{children}</span>
    </div>
  );
}

// How far the whole group has got. Shared by the debt and claim sections — both
// sides of a bill care about the same number.
//
// `plus` credits a payment the registry read doesn't know about yet: a settled
// card is a snapshot taken before the refresh dropped it, so without this the
// bar the user just filled would sit at where it was before they paid.
function GroupProgress({ debt, plus = 0n }: { debt: OwnedDebt; plus?: bigint }) {
  const totalPaid = debt.totalPaid + plus;
  const percent = paidPercent(totalPaid, debt.totalOwed);
  return (
    <div className="settle-aside-row">
      <span className="settle-label">group paid</span>
      <span className="settle-aside-value">
        {usd(totalPaid)} of {usd(debt.totalOwed)}
      </span>
      <span aria-hidden="true" className="settle-progress">
        <span data-settled={plus > 0n || undefined} style={{ width: `${percent}%` }} />
      </span>
      <span className="settle-meta" style={{ marginTop: "0.3rem" }}>
        {percent}% in
        {debt.participantList.length > 0
          ? ` · split ${debt.participantList.length} ${debt.participantList.length === 1 ? "way" : "ways"}`
          : ""}
      </span>
    </div>
  );
}

// The flow running against THIS section, if any. Everything else in the deck
// carries on rendering its amount as usual.
function runningFlow(deck: SettleDeckHandlers, id: string): ProgressFlow | null {
  const flow = deck.progressFlow;
  return flow && flow.subjectKey === id && flow.status === "running" ? flow : null;
}

export default function SettleDeck({
  header,
  socialDebts,
  walletDebts,
  splitterBills,
  nowSeconds,
  signedIn,
  ...deck
}: SettleDeckProps) {
  const fresh = useMemo(
    () => buildSettleItems({ socialDebts, walletDebts, splitterBills, nowSeconds }),
    [socialDebts, walletDebts, splitterBills, nowSeconds],
  );

  const deckRef = useRef<HTMLDivElement | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Sections whose flow succeeded this session. They stay on the deck — paid, in
  // place, with every control dead — until the tab is left, and the count tells
  // the end card whether the user emptied the deck or it simply arrived empty.
  const [settled, setSettled] = useState<HeldSection[]>([]);
  const settledIds = settled.map((entry) => entry.item.id);
  const settledCount = settled.length;
  const items = withHeldSections(fresh, settled);
  // The rail counts payable items only — the divider and end card are chrome.
  // Ids, not items: `.filter` narrows the element type, so indexOf on the array
  // itself would reject a plain SettleItem.
  const countedIds = items.filter((item) => item.kind !== "divider" && item.kind !== "end").map((item) => item.id);
  // Before the observer's first callback nothing is active, which would paint an
  // entirely hidden first section. The top of the deck is the honest default.
  const active = activeId ?? items[0]?.id ?? null;
  // What is still owed above the end card. A settled section stays on the deck,
  // so the rail's own count would report back work the user has just finished.
  const remaining = countedIds.filter((id) => !settledIds.includes(id)).length;
  const { progressFlow } = deck;

  useEffect(() => {
    const node = deckRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.find((entry) => entry.isIntersecting);
        if (visible) setActiveId(visible.target.getAttribute("data-id"));
      },
      { root: node, threshold: 0.6 },
    );
    node.querySelectorAll("[data-id]").forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, [items]);

  // The settled section stays on the deck through the advance and for the rest of
  // the session. Unmounting it the instant the payment lands would pull the snap
  // point out from under the user's thumb mid-scroll, and the registry refresh
  // that follows drops the debt entirely — so the card is captured here, at the
  // index it holds, and put back by withHeldSections. Marking it inside the
  // timeout (rather than on the success render) is also what keeps this out of
  // the synchronous-setState-in-an-effect trap.
  useEffect(() => {
    if (progressFlow?.status !== "success" || !progressFlow.subjectKey) return;
    const key = progressFlow.subjectKey;
    // `items` still describes the section as it was before the flow: the
    // registry refresh is awaited after the flow completes, so it hasn't landed
    // here yet. A bridge or a part-payment leaves the card exactly where it is.
    const index = items.findIndex((item) => item.id === key);
    const item = items[index];
    if (!clearsSection(item, progressFlow)) return;
    const timer = setTimeout(() => {
      setSettled((current) => (current.some((entry) => entry.item.id === key) ? current : [...current, { index, item }]));
      // The next section *below* this one — querying the deck for the first
      // undimmed section walks back up to the top of the list instead.
      const sections = Array.from(deckRef.current?.querySelectorAll("[data-id]") ?? []);
      const from = sections.findIndex((section) => section.getAttribute("data-id") === key);
      const next = sections.slice(from + 1).find((section) => section.getAttribute("data-state") !== "settled");
      next?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 1200);
    return () => clearTimeout(timer);
    // items is deliberately out: the refresh replaces it mid-timeout, and a
    // re-run would cancel the advance it is meant to trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progressFlow?.status, progressFlow?.subjectKey]);

  // Fires once, when the last unpaid section clears — not per card. Under every
  // section in a deck it is noise rather than a reward. Counts `remaining`, not
  // the deck length: settled cards stay mounted now, so the deck never empties.
  useEffect(() => {
    if (remaining > 0 || settledCount === 0) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    void confetti({
      colors: ["#2775ca", "#3ee6d6", "#17a56b"],
      origin: { y: 0.5 },
      particleCount: 110,
      spread: 68,
      startVelocity: 36,
    });
  }, [remaining, settledCount]);

  return (
    <div className="settle-deck" ref={deckRef}>
      {header}
      {items.map((item) => (
        <Section
          active={item.id === active}
          deck={deck}
          index={countedIds.indexOf(item.id)}
          item={item}
          key={item.id}
          remaining={remaining}
          settled={settledIds.includes(item.id)}
          settledCount={settledCount}
          signedIn={signedIn}
          total={countedIds.length}
        />
      ))}
    </div>
  );
}

function Section({
  active,
  deck,
  index,
  item,
  remaining,
  settled,
  settledCount,
  signedIn,
  total,
}: {
  active: boolean;
  deck: SettleDeckHandlers;
  index: number;
  item: SettleItem;
  remaining: number;
  settled: boolean;
  settledCount: number;
  signedIn: boolean;
  total: number;
}) {
  if (item.kind === "divider") {
    return (
      <section className="settle-divider" data-active={active} data-id={item.id}>
        <p className="settle-label">owed to you</p>
        <hr />
        <p className="settle-merchant" style={{ fontSize: "clamp(2rem, 1rem + 3vw, 4rem)", margin: 0 }}>
          {item.claimCount} bill{item.claimCount === 1 ? "" : "s"} · ${item.totalUsd.toFixed(2)}
        </p>
      </section>
    );
  }

  if (item.kind === "end") {
    // Scrolling to the bottom is not the same as clearing the deck — you can
    // pass every section without paying one. The card reports what is actually
    // left above it, and only claims "all settled" when nothing is.
    const cleared = settledCount > 0 ? `${settledCount} ${settledCount === 1 ? "bill" : "bills"} cleared just now. ` : "";
    return (
      <section className="settle-section" data-active={active} data-id={item.id}>
        <h2 className="settle-merchant">
          {remaining > 0
            ? `${remaining} still waiting`
            : settledCount > 0
              ? "all settled"
              : signedIn
                ? "nothing waiting on you"
                : "sign in to settle"}
        </h2>
        <p className="settle-meta">
          {remaining > 0
            ? `${cleared}Scroll back up to settle ${remaining === 1 ? "the last one" : "the rest"}.`
            : settledCount > 0
              ? `${cleared}Nothing else is waiting on you.`
              : signedIn
                ? "Bills tagged to your handle or wallet will appear here."
                : "Sign in or connect a wallet to see the bills tagged to you."}
        </p>
      </section>
    );
  }

  // One word for what the section became, in the register the deck already
  // speaks. Stamped over the card and reused as the dead button's label, so the
  // mark and the control never disagree about what happened.
  const done =
    item.kind === "claim"
      ? "collected"
      : item.kind === "debt-wallet" && item.action === "refund"
        ? "refunded"
        : "paid";

  return (
    <section
      className="settle-section"
      data-active={active}
      data-id={item.id}
      data-state={settled ? "settled" : undefined}
    >
      {/* A lone item gets no counter — snap chrome on a single card is noise. */}
      <div className="settle-rail">
        <span>{total > 1 ? `${String(index + 1).padStart(2, "0")} / ${String(total).padStart(2, "0")}` : ""}</span>
        <span>arc testnet</span>
      </div>
      {/* Decorative: every settled body says the same word in prose below. */}
      {settled ? (
        <p aria-hidden="true" className="settle-stamp">
          {done}
        </p>
      ) : null}
      {item.kind === "debt-social" ? (
        <SocialDebtBody deck={deck} item={item} settled={settled} />
      ) : item.kind === "debt-wallet" ? (
        <WalletDebtBody active={active} deck={deck} item={item} settled={settled} />
      ) : item.kind === "claim" ? (
        <ClaimBody deck={deck} item={item} settled={settled} />
      ) : (
        <FailedClaimBody item={item} />
      )}
    </section>
  );
}

type ItemOf<K extends SettleItem["kind"]> = Extract<SettleItem, { kind: K }>;

// The progress modal's steps, inlined where the amount and the button were. The
// section the money is leaving is the right place to watch it leave.
function FlowSteps({ flow }: { flow: ProgressFlow }) {
  return (
    <ol className="settle-steps">
      {flow.steps.map((step) => (
        <li data-state={step.state} key={step.key}>
          {step.label}
        </li>
      ))}
    </ol>
  );
}

// One shared message line, so an error from any path lands in the same place.
//
// The flow's own error is the fallback because a step that fails mid-flow — a
// rejected chain switch, a mint that can't be paid for — reports through
// failFlow and nothing else. On every other tab ProgressModal shows that text;
// here the modal is suppressed and the steps unmount the moment the status
// leaves "running", so without this the failure is silent.
function DeckMessage({ deck, id }: { deck: SettleDeckHandlers; id: string }) {
  const flow = deck.progressFlow;
  const failed = flow?.subjectKey === id && flow?.status === "error" ? flow : null;
  const failedStep = failed?.steps.find((step) => step.state === "error")?.label;
  const message =
    deck.debtMessages[id] ??
    (failed
      ? {
          tone: "error" as const,
          message: `${failedStep ?? "This"} failed — ${failed.errorMessage || "no reason given."}`,
        }
      : null);
  if (!message) return null;
  return (
    <p className="settle-meta" style={message.tone === "error" ? { color: "var(--warning-text)" } : undefined}>
      {message.message}
    </p>
  );
}

// What stands where the button was once the money has moved. Still a <button>,
// still focusable: a control that vanishes leaves the user wondering whether
// they pressed it, and `disabled` would drop the focus they had on it at the
// moment it settled. aria-disabled announces it as unavailable; with no handler
// there is nothing for a click to do.
function SettledAction({ label }: { label: string }) {
  return (
    <button aria-disabled="true" className="settle-action" data-settled="true" type="button">
      <span aria-hidden="true" className="settle-tick">
        <svg fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
          <path d="M4 12.5 9.5 18 20 6.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      {label}
    </button>
  );
}

function SocialDebtBody({
  deck,
  item,
  settled,
}: {
  deck: SettleDeckHandlers;
  item: ItemOf<"debt-social">;
  settled: boolean;
}) {
  const flow = runningFlow(deck, item.id);
  return (
    <>
      <p className="settle-label">
        to {item.debt.creator?.handle ?? "the creator"}
        {item.debt.creator?.provider ? ` · ${item.debt.creator.provider}` : ""}
      </p>
      <h2 className="settle-merchant">{item.debt.merchant}</h2>
      {flow ? (
        <FlowSteps flow={flow} />
      ) : (
        <>
          <p className="settle-label">{settled ? "you paid" : "you pay"}</p>
          <p className="settle-amount" data-settled={settled || undefined}>
            ${item.debt.amountUsd.toFixed(2)}
          </p>
          <p className="settle-meta">
            {settled
              ? `settled in full from your splitsy wallet — nothing left owing to ${
                  item.debt.creator?.handle ?? "the creator"
                }`
              : "settles in full from your splitsy wallet"}
          </p>
          {settled ? (
            <SettledAction label="Paid" />
          ) : (
            <button
              className="settle-action"
              disabled={deck.billState === "working"}
              onClick={() => deck.paySocialDebt(item.debt)}
              type="button"
            >
              Pay →
            </button>
          )}
        </>
      )}
      <DeckMessage deck={deck} id={item.id} />
    </>
  );
}

function WalletDebtBody({
  active,
  deck,
  item,
  settled,
}: {
  active: boolean;
  deck: SettleDeckHandlers;
  item: ItemOf<"debt-wallet">;
  settled: boolean;
}) {
  const { debt, action, refundable } = item;
  const verification = useBillVerification(debt.billId, debt.metadataHash);
  const merchant = verification.merchant || `Bill #${debt.billId.toString()}`;
  // A mismatch or an altered total is a red warning, not a detail — it opens
  // itself rather than waiting behind a click, because Pay is right there. Only
  // for the section in view: a modal thrown from off-screen is a jump scare.
  // Settled, the money has already moved and the warning has nothing left to
  // stop — it stays available under the trigger, but it stops throwing itself.
  const unsafe = !settled && (verification.status === "mismatch" || verification.audit.state === "altered");
  // null = follow the warning; an explicit open or close pins it. Same shape as
  // BillVerification's receipt toggle, and it needs no effect to do it.
  const [sheet, setSheet] = useState<"verified" | "bridge" | "none" | null>(null);
  const openSheet = sheet ?? (active && unsafe ? "verified" : "none");
  const flow = runningFlow(deck, item.id);
  // Client-side guard only — the contract clamps regardless. Saying so before
  // the signature costs one comparison and saves a rejected transaction.
  const remainingLabel = billUnitsToUsdc(debt.remaining);
  const typed = Number(deck.partialPayments[item.id] ?? remainingLabel);
  const overpaying = action === "pay" && Number.isFinite(typed) && typed > Number(remainingLabel);
  // The input is a live control; once the bill is settled there is nothing left
  // to type an amount against, so the figure goes back to being a figure.
  const editing = item.editable && action === "pay" && !settled;
  // A partly-paid all-or-nothing bill before its deadline: the money is
  // committed but is not yet the creator's, and saying so is the whole point.
  const heldInEscrow = debt.escrowUntilFull && debt.totalPaid < debt.totalOwed && refundable === 0n && debt.paid > 0n;

  return (
    <>
      <p className="settle-label">bill #{debt.billId.toString()}</p>
      <h2 className="settle-merchant">{merchant}</h2>
      {flow ? (
        <FlowSteps flow={flow} />
      ) : (
        <>
          <p className="settle-label">
            {settled ? (action === "refund" ? "you got back" : "you paid") : action === "refund" ? "you get back" : "you pay"}
          </p>
          {editing ? (
            <>
              <input
                aria-label={`Amount to pay on bill ${debt.billId.toString()}`}
                className="settle-amount"
                inputMode="decimal"
                onChange={(event) =>
                  deck.setPartialPayments({ ...deck.partialPayments, [item.id]: event.target.value })
                }
                type="number"
                value={deck.partialPayments[item.id] ?? remainingLabel}
              />
              <span className="settle-rule" data-tone={overpaying ? "warning" : undefined} />
            </>
          ) : (
            <>
              <p className="settle-amount" data-settled={settled || undefined}>
                {usd(action === "refund" ? refundable : debt.remaining)}
              </p>
              <span className="settle-rule" data-tone={settled ? "settled" : undefined} />
            </>
          )}
          <p className="settle-meta">
            {settled
              ? action === "refund"
                ? "your share is back in your wallet — this bill is closed for you"
                : `your ${usd(debt.owed)} share of bill #${debt.billId.toString()} is settled on Arc`
              : action === "refund"
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
          {!item.editable && action === "pay" && !settled ? (
            <p className="settle-meta">settles in full from your splitsy wallet</p>
          ) : null}
          {settled ? (
            <SettledAction label={action === "refund" ? "Refunded" : "Paid"} />
          ) : (
            <button
              className="settle-action"
              disabled={deck.billState === "working" || overpaying}
              onClick={() => (action === "refund" ? deck.refundOnArc(debt) : deck.payDebtOnArc(debt))}
              type="button"
            >
              {action === "refund" ? "Get it back" : "Pay"} →
            </button>
          )}
          {overpaying ? (
            <p className="settle-meta" style={{ color: "var(--warning-text)" }}>
              more than the {usd(debt.remaining)} remaining
            </p>
          ) : null}
        </>
      )}
      <DeckMessage deck={deck} id={item.id} />

      <aside className="settle-aside">
        {/* Settled from this card = the remaining share went in, so credit it. */}
        <GroupProgress debt={debt} plus={settled && action === "pay" ? debt.remaining : 0n} />
        <AsideRow label="your share">
          {usd(debt.owed)}
          {settled ? " · paid in full" : debt.paid > 0n ? ` · ${usd(debt.paid)} paid` : ""}
        </AsideRow>
        <AsideRow label="collected by">{short(debt.splitter)}</AsideRow>
        <AsideRow label={settled ? "paid from" : "paying from"}>{short(debt.account)}</AsideRow>
        {debt.escrowUntilFull ? (
          <p className="settle-meta" style={{ marginTop: 0 }}>
            All or nothing — the bill holds every payment until the group is square.
          </p>
        ) : null}
      </aside>

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
            nothing to bridge into, and a settled one has nothing left to pay. */}
        {item.editable && !settled ? (
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

function ClaimBody({
  deck,
  item,
  settled,
}: {
  deck: SettleDeckHandlers;
  item: ItemOf<"claim">;
  settled: boolean;
}) {
  const { debt } = item;
  const flow = runningFlow(deck, item.id);
  const claimableLabel = billUnitsToUsdc(debt.claimable);
  const typed = Number(deck.claimAmounts[item.id] ?? claimableLabel);
  const overclaiming = Number.isFinite(typed) && typed > Number(claimableLabel);

  return (
    <>
      <p className="settle-label">bill #{debt.billId.toString()}</p>
      <h2 className="settle-merchant">{settled ? "collected" : "ready to collect"}</h2>
      {flow ? (
        <FlowSteps flow={flow} />
      ) : (
        <>
          <p className="settle-label">{settled ? "you collected" : "you collect"}</p>
          {item.editable && !settled ? (
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
              <p className="settle-amount" data-settled={settled || undefined}>
                {usd(debt.claimable)}
              </p>
              <span className="settle-rule" data-tone={settled ? "settled" : undefined} />
            </>
          )}
          <p className="settle-meta">
            {settled
              ? `it's in your wallet — ${usd(debt.claimed + debt.claimable)} collected from this bill in total`
              : `paid ${usd(debt.totalPaid)} · claimed ${usd(debt.claimed)}`}
          </p>
          {!item.editable && !settled ? <p className="settle-meta">collects in full to your splitsy wallet</p> : null}
          {settled ? (
            <SettledAction label="Collected" />
          ) : (
            <button
              className="settle-action"
              disabled={deck.billState === "working" || overclaiming}
              onClick={() => deck.claimSplitterFunds(debt)}
              type="button"
            >
              Collect →
            </button>
          )}
          {overclaiming ? (
            <p className="settle-meta" style={{ color: "var(--warning-text)" }}>
              more than the {usd(debt.claimable)} ready
            </p>
          ) : null}
        </>
      )}
      <DeckMessage deck={deck} id={item.id} />

      <aside className="settle-aside">
        <GroupProgress debt={debt} />
        <AsideRow label="already collected">{usd(settled ? debt.claimed + debt.claimable : debt.claimed)}</AsideRow>
        <AsideRow label={settled ? "collected to" : "collecting to"}>{short(debt.account)}</AsideRow>
        {debt.dueDate > 0n ? (
          <AsideRow label="due">{new Date(Number(debt.dueDate) * 1000).toLocaleDateString()}</AsideRow>
        ) : null}
      </aside>
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
