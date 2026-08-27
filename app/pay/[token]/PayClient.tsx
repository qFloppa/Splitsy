"use client";

import { CheckCircle2, Loader2, Moon, Sun } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useAccount } from "wagmi";
import { getWalletClient, switchChain, writeContract, waitForTransactionReceipt } from "wagmi/actions";
import { arcTestnet } from "viem/chains";
import { formatUnits } from "viem";
import SignInMenu from "@/app/SignInMenu";
import WalletMark from "@/app/WalletMark";
import XAuthControl from "@/app/XAuthControl";
import { Switch } from "@/app/SettlementAgentsPanel";
import { ProviderIcon } from "@/app/ProviderTag";
import type { AccountProvider } from "@/lib/types";
import { useTheme } from "@/lib/use-theme";
import { arcWalletClient, wagmiConfig } from "@/lib/wagmi";
import { coveredByOthers, payableRows, selectionTotalUnits } from "@/lib/pay-link";
import {
  approveBillRegistry,
  billUnitsToUsdc,
  createBillSplitWallet,
  ensureBillSplitWalletOnArc,
  isBillRegistryConfigured,
  payBillDebtFor,
} from "@/lib/bill-split-contracts";
import {
  GATEWAY_MAX_FEE,
  depositToGateway,
  initiateGatewayTransfer,
  waitForGatewayBalance,
} from "@/lib/gateway-browser";
import { CHAIN_CONFIGS } from "@/lib/gateway-contracts";

// Clash is asked for per class in globals.css (.pay-merchant, .pay-amount,
// .pay-row-name, .pay-label, .pay-method, .settle-action) rather than injected
// over the page. The injection that used to live here forced weight 300 on
// .pay-shell *, which flattened every weight the stylesheet asks for — the PAID
// stamp's 700, the row names' 600, the figures' 600 — into hairlines, and set
// --font-display on <html>, so it leaked to every page reached from this one.

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
type RowState = { status: "idle" | "pending" | "signing" | "minting" | "paid" | "failed"; txHash?: string; error?: string };

const usd = (units: string) => `$${Number(billUnitsToUsdc(BigInt(units))).toFixed(2)}`;

// The row's provider arrives as a bare string (the preimage's snapshot, or the
// live users row). Only badge the ones ProviderIcon actually knows — it defaults
// unknown values to the X logo, and claiming the wrong platform is worse than
// claiming none.
const KNOWN_PROVIDERS = new Set(["x", "discord", "email", "wallet"]);

// The app's masthead, minus the tab rail: a share link is opened by people with
// no session, and tabs into an app they have not signed into are five dead ends.
// Everything else is the header the rest of the product wears — the brand lockup,
// the tools in .iou-provider's register, one hairline closing it off. What stood
// here before was a Tailwind band with a `text-sm font-bold` wordmark, RainbowKit's
// own filled pill, and a bordered .icon-button circle: three pieces of chrome the
// redesign had already removed everywhere else.
//
// It keeps the strap that the app shows only on its landing tab, and for the same
// reason turned outward: this page is read cold, by someone who may never have
// heard of Splitsy, and the one fact they must have before paying anything is that
// the money is testnet money. The breathing dot says it louder than the poster's
// dim label does.
//
// The frame is why this is one component rather than a header beside a main. The
// poster wants the viewport under the header, and that used to be spelled
// `calc(100dvh - 4rem)` — a constant measured off the old slim band, wrong for
// this header at every width and wrong twice over below `md`, where it wraps to
// two rows. A flex column of 100dvh hands the same answer down without anyone
// having to know the number.
//
// theme/setTheme are props, not a second useTheme() — the hook holds its own state
// per instance, so two of them would drift apart on the first toggle.
function PayFrame({
  children,
  setTheme,
  theme,
}: Pick<ReturnType<typeof useTheme>, "setTheme" | "theme"> & { children: ReactNode }) {
  return (
    <div className="pay-frame">
      <header className="app-masthead z-30">
        <div className="mx-auto max-w-[88rem] px-4 py-3 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="min-w-0 shrink">
              <Link aria-label="Splitsy home" className="brand-lockup" href="/">
                <span className="logo-crop logo-crop-app">
                  <Image
                    alt="Splitsy"
                    className="logo-crop-image"
                    height={1024}
                    priority
                    src="/splitsy.png"
                    width={1536}
                  />
                </span>
              </Link>
              {/* A <p>, not the app's <h1>: on this page the merchant name is the
                  document's heading. */}
              <div className="app-strap">
                <p className="settle-label app-strapline">Split bills, settle cleanly</p>
                <span className="settle-label app-network">Arc Testnet</span>
              </div>
            </div>
            <div className="app-rails">
              <div className="app-tools">
                <Link className="iou-provider bill-toggle" href="/docs">
                  Docs
                </Link>
                <SignInMenu />
                <WalletMark />
                <button
                  aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
                  className="iou-provider app-icon"
                  onClick={() => setTheme((current) => (current === "light" ? "dark" : "light"))}
                  type="button"
                >
                  {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
                </button>
              </div>
            </div>
          </div>
        </div>
      </header>
      {children}
    </div>
  );
}

// The states with no bill to poster: a token that opens nothing, a chain that
// can't be read, and the beat before the first read lands. All three used to be a
// bare centred block with `text-2xl font-semibold` over a bordered
// .secondary-button — and none of them rendered the header at all, so a mistyped
// link led to a page with no way back and no sign of whose page it was.
//
// Now they speak in the poster's own voice, because that is what they stand in
// for: a caps rail, one display line, prose on a readable measure, and at most one
// borderless control.
function PayVoid({ children, label, title }: { children?: ReactNode; label: string; title: string }) {
  return (
    <main className="pay-void">
      <p className="pay-label">{label}</p>
      <h1 className="pay-merchant">{title}</h1>
      {children}
    </main>
  );
}

export default function PayClient({ token }: { token: string }) {
  const { theme, setTheme } = useTheme();
  const account = useAccount();
  const [bill, setBill] = useState<Bill | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({});
  const [paying, setPaying] = useState(false);
  const [message, setMessage] = useState<string>("");
  const [gatewayChain, setGatewayChain] = useState<string>("Avalanche");

  // Returns the bill it loaded so a payment run can ask the fresh read which of
  // its failed rows someone else covered — see settleRun.
  const load = useCallback(async (): Promise<Bill | null> => {
    const res = await fetch(`/api/pay/${token}`);
    if (!res.ok) {
      setLoadError(res.status === 404 ? "not_found" : "unavailable");
      return null;
    }
    const data = (await res.json()) as Bill;
    setBill(data);
    // Preselect nothing. The payer chooses; a page that arrives with everyone
    // ticked invites an accidental payment of the entire bill.
    setLoadError(null);
    return data;
  }, [token]);

  useEffect(() => {
    // Every setState in load() sits behind `await fetch`, so none of them run
    // synchronously with this effect — the rule cannot see through useCallback
    // to tell. Same call, same reason, as HomeClient.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  if (loadError === "not_found") {
    return (
      <PayFrame setTheme={setTheme} theme={theme}>
        <PayVoid label="No such bill" title="This link doesn't open a bill">
          <p className="pay-fine">It may have been mistyped, or the bill was created without a share link.</p>
          <Link className="settle-action" href="/">
            Splitsy ›
          </Link>
        </PayVoid>
      </PayFrame>
    );
  }

  if (loadError) {
    return (
      <PayFrame setTheme={setTheme} theme={theme}>
        <PayVoid label="Arc unreachable" title="Couldn't reach Arc">
          <p className="pay-fine">The bill exists, but its live balances couldn&apos;t be read just now.</p>
          <button className="settle-action" onClick={() => void load()} type="button">
            Try again ›
          </button>
        </PayVoid>
      </PayFrame>
    );
  }

  if (!bill) {
    return (
      <PayFrame setTheme={setTheme} theme={theme}>
        <main className="pay-void">
          {/* The same mark a signing row shows, at the scale of the whole page —
              a caps line, not a lone spinner on an empty screen. */}
          <p className="pay-label inline-flex items-center gap-2" role="status">
            <Loader2 className="animate-spin" size={14} />
            Reading this bill from Arc
          </p>
        </main>
      </PayFrame>
    );
  }

  const open = payableRows(bill.rows);
  const selectedTotal = selectionTotalUnits(bill.rows, selected);
  const owedUnits = BigInt(bill.totalOwedUnits);
  const paidUnits = BigInt(bill.totalPaidUnits);
  const remainingUnits = owedUnits > paidUnits ? owedUnits - paidUnits : 0n;
  const pct = owedUnits > 0n ? Number((paidUnits * 100n) / owedUnits) : 100;

  const paidCount = bill.rows.filter((r) => BigInt(r.remainingUnits) === 0n).length;
  const totalCount = bill.rows.length;
  const inEscrow = bill.escrowUntilFull && paidCount < totalCount && paidUnits > 0n;
  const escrowReleased = bill.escrowUntilFull && paidCount === totalCount;

  function toggle(address: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(address)) next.delete(address);
      else next.add(address);
      return next;
    });
  }

  // Both pay paths end here. payDebtFor REVERTS rather than clamps when a row
  // was covered while we were signing, and that revert reaches us as a bare
  // "reverted" receipt (browser) or an opaque Circle string (Splitsy) — nothing
  // in either can separate it from a real failure. A fresh read can: a failed
  // row that now sits at zero was covered by someone else, and blaming the payer
  // for it would be a lie. On a public link that race is routine, not exotic.
  async function settleRun(states: Record<string, RowState>) {
    const fresh = await load();
    const failed = Object.entries(states)
      .filter(([, state]) => state.status === "failed")
      .map(([address]) => address);
    const covered = new Set(coveredByOthers(fresh?.rows ?? [], failed));
    setRowStates(Object.fromEntries(Object.entries(states).filter(([address]) => !covered.has(address))));
    const labels = (fresh ?? bill!).rows.filter((row) => covered.has(row.address)).map((row) => row.label);
    setMessage(
      labels.length === 0
        ? ""
        : labels.length === 1
          ? `${labels[0]}'s share was already covered by someone else — you weren't charged for it.`
          : `${labels.join(", ")} were already covered by someone else — you weren't charged for those shares.`,
    );
    setSelected(new Set());
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

    // A share link is read cold, so "no wallet here at all" is an ordinary state
    // on this page. Said in words, because what wagmi throws for it is
    // "ConnectorNotConnectedError".
    if (!account.address) {
      setMessage("Connect a browser wallet to pay on Arc — or use the Splitsy wallet if you have an account.");
      return;
    }

    setPaying(true);
    setMessage("");
    // Tracked locally as well as in state: settleRun needs the finished map, and
    // a setState callback won't have handed it back by the time the loop ends.
    const states: Record<string, RowState> = Object.fromEntries(
      legs.map((l) => [l.address, { status: "pending" } as RowState]),
    );
    setRowStates({ ...states });

    try {
      // Whatever chain the payer arrived on, the registry is on Arc. Announced
      // rather than done silently: the wallet is about to raise a network prompt,
      // and an unexplained one reads as a phishing attempt.
      setMessage("Switching to Arc Testnet…");
      const walletClient = await arcWalletClient();
      const wallet = await createBillSplitWallet(walletClient);
      await ensureBillSplitWalletOnArc(wallet);

      setMessage("Approving USDC…");
      await approveBillRegistry({ ...wallet, amount: selectedTotal });

      for (const leg of legs) {
        states[leg.address] = { status: "signing" };
        setRowStates({ ...states });
        try {
          const receipt = await payBillDebtFor({
            ...wallet,
            billId: BigInt(bill!.billId),
            debtor: leg.address as `0x${string}`,
            amount: BigInt(leg.remainingUnits),
          });
          states[leg.address] = { status: "paid", txHash: receipt.transactionHash };
        } catch (err) {
          states[leg.address] = { status: "failed", error: err instanceof Error ? err.message : "Payment failed" };
        }
        setRowStates({ ...states });
      }
      await settleRun(states);
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

    // A share link is opened by strangers, so signed-out is the ordinary case
    // here rather than an edge one. /api/wallet/pin answers 401 for them, and
    // telling someone with no account to unlock a wallet is a dead end.
    const pinRes = await fetch("/api/wallet/pin").catch(() => null);
    if (!pinRes) {
      setMessage("Couldn't reach Splitsy just now. Check your connection and try again.");
      return;
    }
    if (pinRes.status === 401) {
      setMessage("Sign in to pay from a Splitsy wallet — or use Pay on Arc with a browser wallet.");
      return;
    }
    const pin = await pinRes.json().catch(() => ({}));
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
      const states: Record<string, RowState> = Object.fromEntries(
        results.map((r) => [
          r.address,
          r.ok ? { status: "paid" as const, txHash: r.txHash } : { status: "failed" as const, error: r.error },
        ]),
      );
      setRowStates(states);
      await settleRun(states);
    } catch (err) {
      // Without this the request dying mid-flight left every row spinning on
      // `pending` with nothing said, and threw past the `void` at the call site.
      setMessage(err instanceof Error ? err.message : "Payment failed.");
      setRowStates({});
    } finally {
      setPaying(false);
    }
  }

  // Gateway: bring USDC from another testnet chain onto Arc, then settle the
  // selected rows through the registry exactly as "Pay on Arc" does.
  //
  // The mint lands in the PAYER's own Arc wallet, not the debtor's. Paying a
  // debtor's address directly moves USDC but leaves the registry untouched:
  // the bill still reads unpaid, escrow never releases, and the creator can
  // never claim. Gateway is the funding step; payDebtFor is the payment.
  async function payWithGateway() {
    if (!isBillRegistryConfigured()) {
      setMessage("Bill registry is not configured.");
      return;
    }
    const legs = bill!.rows.filter((r) => selected.has(r.address) && BigInt(r.remainingUnits) > 0n);
    if (legs.length === 0) return;

    if (!account.address) {
      setMessage("Connect your browser wallet to use Gateway");
      return;
    }

    setPaying(true);
    setMessage("");
    const states: Record<string, RowState> = Object.fromEntries(
      legs.map((l) => [l.address, { status: "pending" } as RowState]),
    );
    setRowStates({ ...states });

    try {
      const sourceChainConfig = CHAIN_CONFIGS[gatewayChain];
      if (!sourceChainConfig?.testnet) {
        setMessage(`Chain ${gatewayChain} not supported`);
        setRowStates({});
        return;
      }

      const payer = account.address;
      const total = legs.reduce((sum, leg) => sum + BigInt(leg.remainingUnits), 0n);
      // Gateway decrements the balance by value + fee when it attests, so the
      // deposit has to cover both or the transfer is rejected for insufficient
      // funds. Unused fee headroom stays credited for the next payment.
      const funding = total + GATEWAY_MAX_FEE;

      setMessage(`Switching to ${gatewayChain}…`);
      try {
        // Every chain in CHAIN_CONFIGS is registered in wagmiConfig, so this id
        // really is one of its chains — ViemChain.id is just typed as `number`.
        await switchChain(wagmiConfig, {
          chainId: sourceChainConfig.testnet.ViemChain.id as (typeof wagmiConfig)["chains"][number]["id"],
        });
      } catch {
        setMessage(`Failed to switch to ${gatewayChain}. Please switch manually and try again.`);
        setRowStates({});
        return;
      }

      const walletClient = await getWalletClient(wagmiConfig, { account: payer });
      if (!walletClient) {
        setMessage("Wallet not connected");
        setRowStates({});
        return;
      }

      setMessage(`Depositing into Gateway on ${gatewayChain}…`);
      const deposit = await depositToGateway({
        walletClient,
        sourceChain: gatewayChain,
        amountUsdc: formatUnits(funding, 6),
      });

      if (!deposit.success) {
        setMessage(`Deposit failed: ${deposit.error}`);
        setRowStates({});
        return;
      }

      // A deposit is only spendable once its events finalize — seconds on Fuji,
      // but up to ~19 minutes on the Sepolia-family chains. Transferring before
      // then fails with an opaque insufficient-balance error, so wait and say so.
      if (!deposit.alreadyFunded) {
        setMessage(`Waiting for ${gatewayChain} to finalize the deposit — this can take a few minutes…`);
        const funded = await waitForGatewayBalance({
          domain: sourceChainConfig.domain,
          depositor: payer,
          needed: funding,
          onWait: (elapsed) =>
            setMessage(
              `Waiting for ${gatewayChain} to finalize the deposit (${Math.round(elapsed / 1000)}s). ` +
                `Your USDC is safe in Gateway — you can leave this page and pay again later.`,
            ),
        });
        if (!funded) {
          setMessage(
            `${gatewayChain} hasn't finalized the deposit yet. Your USDC is credited to Gateway and nothing was lost — ` +
              `reopen this link in a few minutes and tap Pay via Gateway again to finish.`,
          );
          setRowStates({});
          return;
        }
      }

      // One burn intent for the whole selection: the fee is charged per intent,
      // so N rows funded one-by-one would pay it N times.
      setMessage("Signing the transfer to Arc…");
      const transfer = await initiateGatewayTransfer({
        walletClient,
        sourceChain: gatewayChain,
        amountUsdc: formatUnits(total, 6),
        recipientAddress: payer,
      });

      if (!transfer.success || !transfer.mintData) {
        setMessage(transfer.error ?? "Gateway signing failed");
        setRowStates({});
        return;
      }

      setMessage("Minting on Arc…");
      await switchChain(wagmiConfig, { chainId: arcTestnet.id });
      const mintHash = await writeContract(wagmiConfig, transfer.mintData);
      await waitForTransactionReceipt(wagmiConfig, { hash: mintHash });

      // From here the money is on Arc in the payer's wallet, so this is the
      // ordinary browser-wallet settlement — same approve-then-payDebtFor shape.
      const wallet = await createBillSplitWallet(await arcWalletClient());
      await ensureBillSplitWalletOnArc(wallet);

      setMessage("Approving USDC…");
      await approveBillRegistry({ ...wallet, amount: total });

      for (const leg of legs) {
        states[leg.address] = { status: "signing" };
        setRowStates({ ...states });
        try {
          const receipt = await payBillDebtFor({
            ...wallet,
            billId: BigInt(bill!.billId),
            debtor: leg.address as `0x${string}`,
            amount: BigInt(leg.remainingUnits),
          });
          states[leg.address] = { status: "paid", txHash: receipt.transactionHash };
        } catch (err) {
          states[leg.address] = { status: "failed", error: err instanceof Error ? err.message : "Payment failed" };
        }
        setRowStates({ ...states });
      }
      await settleRun(states);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Gateway payment failed");
      setRowStates({});
    } finally {
      setPaying(false);
    }
  }

  return (
    <>
      <PayFrame setTheme={setTheme} theme={theme}>
        <main className="pay-shell">
        <aside className="pay-poster" data-settled={bill.settled}>
          <div>
            <p className="pay-label">Bill #{bill.billId} · Arc Testnet</p>
            <h1 className="pay-merchant">{bill.merchant || "Bill"}</h1>
            {bill.settled ? (
              <p className="pay-amount" data-settled="true">
                Settled
              </p>
            ) : (
              <p className="pay-amount">{usd(remainingUnits.toString())}</p>
            )}
            <p className="settle-meta amount-text">
              {bill.settled ? `${usd(bill.totalOwedUnits)} of ${usd(bill.totalOwedUnits)}` : `still owed of ${usd(bill.totalOwedUnits)}`}
            </p>
            <div className="pay-progress">
              <span style={{ width: `${Math.min(100, pct)}%` }} />
            </div>
            {/* Escrow, as a note rather than the tinted bordered chip it was: the
                rule above it carries the emphasis and the caps label carries the
                tone. No icon — the label says it, and this system stopped
                illustrating its own headings. */}
            {inEscrow ? (
              <div className="doc-note pay-note" data-tone="warn">
                <p className="settle-label">
                  {paidCount}/{totalCount} paid · held in escrow
                </p>
                <p>Every payment stays in the bill until all shares are covered.</p>
              </div>
            ) : escrowReleased ? (
              <div className="doc-note pay-note" data-tone="ok">
                <p className="settle-label">All shares paid</p>
                <p>
                  {bill.creator.label ?? "The creator"} can collect {usd(bill.totalOwedUnits)}.
                </p>
              </div>
            ) : null}
          </div>
          <div className="pay-fine">
            {/* An icon, not a "✓" glyph: the character is drawn by whatever font
                falls through for it, at whatever weight, and this is the line
                asserting the bill is real. */}
            <p className="pay-verified">
              <CheckCircle2 size={14} strokeWidth={2.2} />
              Details verified against Arc
            </p>
            <p>
              Created by {bill.creator.label ?? `${bill.creator.address.slice(0, 6)}…${bill.creator.address.slice(-4)}`}
              {bill.dueDate > 0 ? ` · due ${new Date(bill.dueDate * 1000).toLocaleDateString()}` : ""}
            </p>
            {/* Only while the note above isn't already saying it. This line states
                the bill's rule; the note states the same rule with the group's
                actual numbers in it, so together they said escrow twice — and the
                duplicate was what pushed the last line of this block under the
                action bar in exactly the state that adds the note. */}
            {bill.escrowUntilFull && !inEscrow && !escrowReleased ? (
              <p>Held in escrow until every share is paid</p>
            ) : null}
          </div>
        </aside>

        <section className="pay-roster">
          {bill.settled ? (
            // Left-aligned, like every row that was here a moment ago. Centring
            // one state of a column breaks the column.
            <>
              <p className="pay-label">Nothing left to pay</p>
              <p className="pay-cleared">Everyone&apos;s covered</p>
              <p className="pay-fine">
                All {bill.rows.length} shares are paid. {bill.creator.label ?? "The creator"} can collect{" "}
                {usd(bill.totalOwedUnits)} from Arc.
              </p>
            </>
          ) : (
            <>
              <p className="pay-label">
                {paying ? "Settling — don't close this tab" : "Choose who you're covering"}
              </p>
              {message ? <p className="bill-poster-msg" data-tone="error">{message}</p> : null}
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
                      ) : state === "signing" || state === "minting" ? (
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
                        <p className="pay-row-name flex items-center gap-2">
                          {KNOWN_PROVIDERS.has(row.provider ?? "") ? (
                            <span className="flex shrink-0 items-center">
                              <ProviderIcon provider={row.provider as AccountProvider} size={20} />
                            </span>
                          ) : null}
                          <span className="truncate">{row.label}</span>
                        </p>
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
                        <span className="settle-label pay-stamp">Paid</span>
                      ) : (
                        <span className="pay-row-amount">{usd(row.remainingUnits)}</span>
                      )}
                    </div>
                  );
                })}
              </div>
              {open.length === 0 ? (
                <p className="pay-fine mt-4">Every share on this bill is already settled.</p>
              ) : null}
            </>
          )}
        </section>
      </main>
      </PayFrame>

      {/* Outside the frame on purpose: the frame is exactly one viewport tall, and
          this bar is sticky to the BOTTOM of the document so it stays pinned over
          the roster however far it scrolls. Inside, it would pin to the frame's
          own bottom edge and scroll away with the first screen. */}
      {bill.settled ? null : (
        <div className="pay-bar">
          <div className="pay-bar-sum" data-armed={selected.size > 0}>
            <span className="pay-label">You pay</span>
            <div className="pay-bar-figure">
              <span className="pay-bar-total">{usd(selectedTotal.toString())}</span>
              <span className="pay-bar-count">
                {selected.size === 0
                  ? "no shares picked yet"
                  : `${selected.size} share${selected.size === 1 ? "" : "s"} selected`}
              </span>
            </div>
          </div>
          <div className="pay-bar-actions">
            {/* Labelled as alternates so the ordinary path stays the one big
                word on the right, and reading all three is opt-in. */}
            <div className="pay-methods">
              <span className="pay-label">Other ways</span>
              <div className="pay-method-row">
                <button
                  className="pay-method"
                  disabled={paying || selected.size === 0}
                  onClick={() => void payWithSplitsyWallet()}
                  title="Splitsy wallet (Arc Testnet only) — uses your DCW wallet"
                  type="button"
                >
                  Splitsy wallet
                </button>
                {/* One segmented control: the chain is Gateway's input, not a
                    third way to pay. */}
                <div className="pay-method-pair">
                  <select
                    aria-label="Chain to bridge from via Gateway"
                    className="pay-method"
                    disabled={paying}
                    onChange={(e) => setGatewayChain(e.target.value)}
                    value={gatewayChain}
                  >
                    <option value="Avalanche">Avalanche</option>
                    <option value="Base">Base</option>
                    <option value="Ethereum">Ethereum</option>
                    <option value="Arbitrum">Arbitrum</option>
                  </select>
                  <button
                    className="pay-method"
                    disabled={paying || selected.size === 0}
                    onClick={() => void payWithGateway()}
                    title="Cross-chain payment via Circle Gateway (browser wallet only)"
                    type="button"
                  >
                    via Gateway
                  </button>
                </div>
              </div>
            </div>
            <button
              className="settle-action"
              disabled={paying || selected.size === 0}
              onClick={() => void payWithBrowserWallet()}
              type="button"
            >
              {paying ? <Loader2 className="animate-spin" size={16} /> : null}
              Pay on Arc ›
            </button>
          </div>
        </div>
      )}

      <XAuthControl />
    </>
  );
}
