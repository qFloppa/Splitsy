"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { getWalletClient } from "wagmi/actions";
import { arcTestnet } from "viem/chains";
import SignInMenu from "@/app/SignInMenu";
import XAuthControl from "@/app/XAuthControl";
import { Switch } from "@/app/SettlementAgentsPanel";
import { wagmiConfig } from "@/lib/wagmi";
import { payableRows, selectionTotalUnits } from "@/lib/pay-link";
import {
  approveBillRegistry,
  billUnitsToUsdc,
  createBillSplitWallet,
  ensureBillSplitWalletOnArc,
  isBillRegistryConfigured,
  payBillDebtFor,
} from "@/lib/bill-split-contracts";

type Row = {
  address: string;
  label: string;
  provider: string | null;
  owedUnits: string;
  paidUnits: string;
  remainingUnits: string;
};

type Bill = {
  billId: string;
  merchant: string;
  currency: string;
  total: number;
  dueDate: number;
  escrowUntilFull: boolean;
  receiptUrl: string | null;
  creator: { address: string; label: string | null; provider: string | null };
  totalOwedUnits: string;
  totalPaidUnits: string;
  settled: boolean;
  rows: Row[];
};

// Per-row progress during a payment run. `pending` rows are queued behind the
// row currently signing — shown as queued rather than as failures.
type RowState = { status: "idle" | "pending" | "signing" | "paid" | "failed"; txHash?: string; error?: string };

const usd = (units: string) => `$${Number(billUnitsToUsdc(BigInt(units))).toFixed(2)}`;

export default function PayClient({ token }: { token: string }) {
  const [bill, setBill] = useState<Bill | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({});
  const [paying, setPaying] = useState(false);
  const [message, setMessage] = useState<string>("");

  const load = useCallback(async () => {
    const res = await fetch(`/api/pay/${token}`);
    if (!res.ok) {
      setLoadError(res.status === 404 ? "not_found" : "unavailable");
      return;
    }
    const data = (await res.json()) as Bill;
    setBill(data);
    // Preselect nothing. The payer chooses; a page that arrives with everyone
    // ticked invites an accidental payment of the entire bill.
    setLoadError(null);
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loadError === "not_found") {
    return (
      <main className="mx-auto flex min-h-[70dvh] max-w-lg flex-col items-center justify-center gap-3 px-6 text-center">
        <h1 className="text-2xl font-semibold text-[var(--text)]">This link doesn&apos;t open a bill</h1>
        <p className="text-[var(--text-muted)]">
          It may have been mistyped, or the bill was created without a share link.
        </p>
        <Link className="secondary-button mt-2" href="/">
          Go to Splitsy
        </Link>
      </main>
    );
  }

  if (loadError) {
    return (
      <main className="mx-auto flex min-h-[70dvh] max-w-lg flex-col items-center justify-center gap-3 px-6 text-center">
        <h1 className="text-2xl font-semibold text-[var(--text)]">Couldn&apos;t reach Arc</h1>
        <p className="text-[var(--text-muted)]">The bill exists, but its live balances couldn&apos;t be read just now.</p>
        <button className="secondary-button mt-2" onClick={() => void load()} type="button">
          Try again
        </button>
      </main>
    );
  }

  if (!bill) {
    return (
      <main className="flex min-h-[70dvh] items-center justify-center">
        <Loader2 className="animate-spin text-[var(--text-muted)]" size={22} />
      </main>
    );
  }

  const open = payableRows(bill.rows);
  const selectedTotal = selectionTotalUnits(bill.rows, selected);
  const owedUnits = BigInt(bill.totalOwedUnits);
  const paidUnits = BigInt(bill.totalPaidUnits);
  const remainingUnits = owedUnits > paidUnits ? owedUnits - paidUnits : 0n;
  const pct = owedUnits > 0n ? Number((paidUnits * 100n) / owedUnits) : 100;

  function toggle(address: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(address)) next.delete(address);
      else next.add(address);
      return next;
    });
  }

  // Browser wallet: one approval for the whole selection, then one payDebtFor
  // per row. The registry has no batch pay-for-others, so the honest thing is to
  // show each row settling on its own — and to leave the earlier rows paid when
  // a later one fails.
  async function payWithBrowserWallet() {
    if (!isBillRegistryConfigured()) {
      setMessage("Bill registry is not configured.");
      return;
    }
    const legs = bill!.rows.filter((r) => selected.has(r.address) && BigInt(r.remainingUnits) > 0n);
    if (legs.length === 0) return;

    setPaying(true);
    setMessage("");
    setRowStates(Object.fromEntries(legs.map((l) => [l.address, { status: "pending" } as RowState])));

    try {
      const walletClient = await getWalletClient(wagmiConfig, { chainId: arcTestnet.id });
      const wallet = await createBillSplitWallet(walletClient);
      await ensureBillSplitWalletOnArc(wallet);

      setMessage("Approving USDC…");
      await approveBillRegistry({ ...wallet, amount: selectedTotal });

      for (const leg of legs) {
        setRowStates((s) => ({ ...s, [leg.address]: { status: "signing" } }));
        try {
          const receipt = await payBillDebtFor({
            ...wallet,
            billId: BigInt(bill!.billId),
            debtor: leg.address as `0x${string}`,
            amount: BigInt(leg.remainingUnits),
          });
          setRowStates((s) => ({ ...s, [leg.address]: { status: "paid", txHash: receipt.transactionHash } }));
        } catch (err) {
          setRowStates((s) => ({
            ...s,
            [leg.address]: { status: "failed", error: err instanceof Error ? err.message : "Payment failed" },
          }));
        }
      }
      setMessage("");
      setSelected(new Set());
      await load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Payment failed.");
    } finally {
      setPaying(false);
    }
  }

  // Splitsy wallet: the server signs. One request, per-row results back.
  async function payWithSplitsyWallet() {
    const legs = bill!.rows.filter((r) => selected.has(r.address) && BigInt(r.remainingUnits) > 0n);
    if (legs.length === 0) return;

    const pin = await fetch("/api/wallet/pin").then((r) => r.json()).catch(() => ({}));
    if (!pin.unlocked) {
      setMessage("Unlock your wallet (the wallet button in the bottom-right corner), then tap Pay again.");
      return;
    }

    setPaying(true);
    setMessage("");
    setRowStates(Object.fromEntries(legs.map((l) => [l.address, { status: "pending" } as RowState])));
    try {
      const res = await fetch(`/api/pay/${token}/social`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ debtors: legs.map((l) => l.address) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(
          data.error === "insufficient_funds"
            ? "Your wallet needs more test USDC to cover this."
            : data.error === "locked"
              ? "Unlock your wallet (the wallet button in the bottom-right corner), then tap Pay again."
              : (data.error ?? "Payment failed."),
        );
        setRowStates({});
        return;
      }
      const results = (data.results ?? []) as { address: string; ok: boolean; txHash?: string; error?: string }[];
      setRowStates(
        Object.fromEntries(
          results.map((r) => [
            r.address,
            r.ok ? { status: "paid" as const, txHash: r.txHash } : { status: "failed" as const, error: r.error },
          ]),
        ),
      );
      setSelected(new Set());
      await load();
    } finally {
      setPaying(false);
    }
  }

  return (
    <>
      <header className="flex items-center justify-between border-b border-[var(--border)] bg-[color:var(--header-bg)] px-5 py-3 backdrop-blur-xl">
        <Link className="text-sm font-bold tracking-tight text-[var(--text)] no-underline" href="/">
          Splitsy
        </Link>
        <div className="flex items-center gap-2">
          <SignInMenu />
          <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false} />
        </div>
      </header>

      <main className="pay-shell">
        <aside className="pay-poster" data-settled={bill.settled}>
          <div>
            <p className="text-[0.62rem] font-semibold uppercase tracking-[0.14em] text-[rgba(247,243,234,0.55)]">
              Bill #{bill.billId} · Arc Testnet
            </p>
            <h1 className="pay-merchant">{bill.merchant || "Bill"}</h1>
            {bill.settled ? (
              <p className="pay-amount" data-settled="true">
                Settled
              </p>
            ) : (
              <p className="pay-amount">{usd(remainingUnits.toString())}</p>
            )}
            <p className="amount-text mt-1 text-xs text-[rgba(247,243,234,0.6)]">
              {bill.settled ? `${usd(bill.totalOwedUnits)} of ${usd(bill.totalOwedUnits)}` : `still owed of ${usd(bill.totalOwedUnits)}`}
            </p>
            <div className="pay-progress">
              <span style={{ width: `${Math.min(100, pct)}%` }} />
            </div>
          </div>
          <div className="text-[0.62rem] leading-relaxed text-[rgba(247,243,234,0.55)]">
            <p>✓ Details verified against Arc</p>
            <p>
              Created by {bill.creator.label ?? `${bill.creator.address.slice(0, 6)}…${bill.creator.address.slice(-4)}`}
              {bill.dueDate > 0 ? ` · due ${new Date(bill.dueDate * 1000).toLocaleDateString()}` : ""}
            </p>
            {bill.escrowUntilFull ? <p>Held in escrow until every share is paid</p> : null}
          </div>
        </aside>

        <section className="pay-roster">
          {bill.settled ? (
            <div className="flex min-h-[40dvh] flex-col items-center justify-center gap-2 text-center">
              <p className="pay-row-name text-2xl">Everyone&apos;s covered</p>
              <p className="max-w-xs text-sm text-[var(--text-muted)]">
                All {bill.rows.length} shares are paid. {bill.creator.label ?? "The creator"} can collect{" "}
                {usd(bill.totalOwedUnits)} from Arc.
              </p>
            </div>
          ) : (
            <>
              <p className="text-[0.62rem] font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">
                {paying ? "Settling — don't close this tab" : "Choose who you're covering"}
              </p>
              {message ? <p className="mt-2 text-sm text-[var(--warning-text)]">{message}</p> : null}
              <div className="mt-2">
                {bill.rows.map((row) => {
                  const state = rowStates[row.address]?.status ?? "idle";
                  const done = BigInt(row.remainingUnits) === 0n || state === "paid";
                  return (
                    <div
                      className="pay-row"
                      data-selected={!done && selected.has(row.address)}
                      data-state={done ? "paid" : state}
                      key={row.address}
                    >
                      {done ? (
                        <span className="w-[34px] shrink-0" />
                      ) : state === "signing" ? (
                        <Loader2 className="shrink-0 animate-spin text-[var(--accent)]" size={18} />
                      ) : (
                        <Switch
                          checked={selected.has(row.address)}
                          disabled={paying}
                          onChange={() => toggle(row.address)}
                          srLabel={`Cover ${row.label}'s share`}
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="pay-row-name truncate">{row.label}</p>
                        <p className="pay-row-meta">
                          {state === "signing"
                            ? "waiting for confirmation…"
                            : state === "failed"
                              ? (rowStates[row.address]?.error ?? "failed — try again")
                              : done
                                ? "settled"
                                : `owes ${usd(row.remainingUnits)} of ${usd(row.owedUnits)}`}
                        </p>
                      </div>
                      {done ? (
                        <span className="pay-stamp">PAID</span>
                      ) : (
                        <span className="pay-row-amount">{usd(row.remainingUnits)}</span>
                      )}
                    </div>
                  );
                })}
              </div>
              {open.length === 0 ? (
                <p className="mt-4 text-sm text-[var(--text-muted)]">Every share on this bill is already settled.</p>
              ) : null}
            </>
          )}
        </section>
      </main>

      {bill.settled ? null : (
        <div className="pay-bar">
          <span className="flex items-baseline gap-2">
            <span className="text-[0.62rem] font-semibold uppercase tracking-[0.14em] text-[rgba(247,243,234,0.6)]">
              You pay
            </span>
            <span className="pay-bar-total">{usd(selectedTotal.toString())}</span>
            <span className="text-xs text-[rgba(247,243,234,0.6)]">
              · {selected.size} row{selected.size === 1 ? "" : "s"}
            </span>
          </span>
          <span className="flex gap-2">
            <button
              className="secondary-button"
              disabled={paying || selected.size === 0}
              onClick={() => void payWithSplitsyWallet()}
              type="button"
            >
              Pay with Splitsy wallet
            </button>
            <button
              className="primary-button"
              disabled={paying || selected.size === 0}
              onClick={() => void payWithBrowserWallet()}
              type="button"
            >
              {paying ? <Loader2 className="animate-spin" size={16} /> : null}
              Pay on Arc
            </button>
          </span>
        </div>
      )}

      <XAuthControl />
    </>
  );
}
