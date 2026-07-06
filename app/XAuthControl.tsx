"use client";

import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowDownLeft,
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowUpRight,
  Check,
  Copy,
  ExternalLink,
  GripVertical,
  Loader2,
  LogOut,
  Wallet,
  X,
} from "lucide-react";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { readArcUsdcBalance, billUnitsToUsdc } from "@/lib/bill-split-contracts";

type Me = { id: string; handle: string; name: string | null; avatarUrl: string | null; walletAddress: string | null };
type Tab = "info" | "send" | "receive" | "history";

function Usdc({ size = 14 }: { size?: number }) {
  return <Image src="/usd-coin-usdc-seeklogo.png" alt="USDC" width={size} height={size} className="inline-block align-text-bottom" />;
}

export default function XAuthControl() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [balance, setBalance] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState<Tab>("info");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/me")
      .then((r) => r.json())
      .then((data: { user: Me | null }) => {
        if (active) setMe(data.user);
      })
      .catch(() => {
        if (active) setMe(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  function refreshBalance() {
    if (!me?.walletAddress) return;
    readArcUsdcBalance(me.walletAddress as `0x${string}`)
      .then((b) => setBalance(billUnitsToUsdc(b)))
      .catch(() => setBalance(null));
  }

  useEffect(() => {
    if (open && me?.walletAddress) refreshBalance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, me?.walletAddress]);

  function copyAddress() {
    if (!me?.walletAddress) return;
    void navigator.clipboard.writeText(me.walletAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (loading || !me) {
    if (loading) return null;
    return (
      <a
        href="/api/auth/twitter"
        className="inline-flex items-center gap-2 rounded-full bg-[#1d9bf0] px-3 py-1.5 text-sm font-semibold text-white"
      >
        Sign in with X
      </a>
    );
  }

  const short = me.walletAddress ? `${me.walletAddress.slice(0, 6)}…${me.walletAddress.slice(-4)}` : null;

  return (
    <div ref={ref}>
      {/* Floating avatar toggle — pulses to invite a click, uses the X avatar. */}
      <motion.button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Open your wallet"
        className="fixed bottom-6 right-6 z-[65] flex h-14 w-14 items-center justify-center rounded-full border-2 border-[#2775ca] bg-[var(--surface)] shadow-xl"
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        whileHover={{ scale: 1.08 }}
        whileTap={{ scale: 0.95 }}
        transition={{ type: "spring", stiffness: 300, damping: 18 }}
      >
        {me.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={me.avatarUrl} alt="" width={48} height={48} className="h-12 w-12 rounded-full" />
        ) : (
          <Wallet size={22} className="text-[#2775ca]" />
        )}
        <span className="absolute -right-0.5 -top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-[#2775ca] text-white">
          <Wallet size={11} />
        </span>
      </motion.button>

      <AnimatePresence>
        {open ? (
          <motion.div
            drag
            dragMomentum={false}
            dragElastic={0.12}
            initial={{ opacity: 0, scale: 0.9, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 12 }}
            transition={{ type: "spring", stiffness: 340, damping: 26 }}
            whileDrag={{ scale: 1.03, boxShadow: "0 24px 60px rgba(0,0,0,0.45)" }}
            className="fixed bottom-24 right-6 z-[70] w-80 select-none rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-muted)] shadow-2xl"
          >
            <div className="flex cursor-grab items-center justify-between rounded-t-[var(--radius)] border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2 active:cursor-grabbing">
              <span className="flex items-center gap-1.5 text-xs font-semibold text-[var(--text-muted)]">
                <GripVertical size={14} />
                My wallet
              </span>
              <div className="flex items-center gap-2">
                <form action="/api/auth/logout" method="post">
                  <button type="submit" aria-label="Log out" className="text-[var(--text-muted)] hover:text-[var(--text)]">
                    <LogOut size={14} />
                  </button>
                </form>
                <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="text-[var(--text-muted)] hover:text-[var(--text)]">
                  <X size={15} />
                </button>
              </div>
            </div>

            <div className="p-4">
              <div className="flex items-center gap-3">
                {me.avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={me.avatarUrl} alt="" width={36} height={36} className="h-9 w-9 rounded-full" />
                ) : null}
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">@{me.handle}</p>
                  <p className="flex items-center gap-1 text-xs text-[var(--text-muted)]">
                    <Usdc size={12} /> {balance ?? "…"} USDC
                  </p>
                </div>
              </div>

              <div className="mt-3 grid grid-cols-4 gap-1 rounded-full bg-[var(--surface)] p-1 text-xs font-semibold">
                {(["info", "send", "receive", "history"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTab(t)}
                    className={`rounded-full py-1.5 capitalize transition ${
                      tab === t ? "bg-[#2775ca] text-white" : "text-[var(--text-muted)] hover:text-[var(--text)]"
                    }`}
                  >
                    {t === "info" ? "Wallet" : t}
                  </button>
                ))}
              </div>

              <div className="mt-3 border-t border-[var(--border)] pt-3">
                {tab === "info" ? (
                  <>
                    <div className="flex items-center gap-2">
                      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#2775ca]/15 text-[#2775ca]">
                        <Wallet size={16} />
                      </span>
                      <p className="text-sm font-semibold">Your wallet</p>
                    </div>
                    <p className="mt-2 text-sm text-[var(--text-muted)]">
                      A Circle wallet on <strong className="text-[var(--text)]">Arc Testnet</strong>, tied to{" "}
                      <strong className="text-[var(--text)]">@{me.handle}</strong>. Pay and get paid in USDC — no crypto
                      setup needed.
                    </p>
                    {me.walletAddress ? (
                      <>
                        <div className="mt-3 flex items-center justify-between gap-2 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5">
                          <code className="text-xs">{short}</code>
                          <button type="button" onClick={copyAddress} className="flex items-center gap-1 text-xs font-semibold text-[#1d9bf0]">
                            {copied ? <Check size={13} /> : <Copy size={13} />}
                            {copied ? "Copied" : "Copy"}
                          </button>
                        </div>
                        <p className="mt-2 flex items-center gap-1 text-sm">
                          Balance: <Usdc /> <strong className="amount-text">{balance ?? "…"} USDC</strong>
                        </p>
                        <a
                          href="https://faucet.circle.com"
                          target="_blank"
                          rel="noreferrer"
                          className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-[#2775ca]/15 px-3 py-1.5 text-xs font-semibold text-[#2775ca] transition hover:bg-[#2775ca]/25"
                        >
                          <ExternalLink size={13} />
                          Add test USDC · faucet.circle.com
                        </a>
                      </>
                    ) : (
                      <p className="mt-2 text-sm text-[var(--text-muted)]">Your wallet is being created — refresh in a moment.</p>
                    )}
                  </>
                ) : tab === "send" ? (
                  <SendTab balance={balance} onSent={refreshBalance} />
                ) : tab === "receive" ? (
                  <ReceiveTab address={me.walletAddress} short={short} copied={copied} onCopy={copyAddress} />
                ) : (
                  <HistoryTab ownShort={short} />
                )}
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function ReceiveTab({ address, short, copied, onCopy }: { address: string | null; short: string | null; copied: boolean; onCopy: () => void }) {
  if (!address) return <p className="text-sm text-[var(--text-muted)]">Your wallet is being created — refresh in a moment.</p>;
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#17a56b]/15 text-[#17a56b]">
          <ArrowDownToLine size={16} />
        </span>
        <p className="text-sm font-semibold">
          Receive <Usdc />
        </p>
      </div>
      <p className="mt-2 text-sm text-[var(--text-muted)]">
        Share this address to receive USDC on <strong className="text-[var(--text)]">Arc Testnet</strong>.
      </p>
      <div className="mt-3 break-all rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-xs">{address}</div>
      <button type="button" onClick={onCopy} className="mt-2 flex items-center gap-1 text-xs font-semibold text-[#1d9bf0]">
        {copied ? <Check size={13} /> : <Copy size={13} />}
        {copied ? "Copied" : `Copy ${short}`}
      </button>
    </div>
  );
}

type SendPhase = "form" | "sending" | "done" | "error";

function SendTab({ balance, onSent }: { balance: string | null; onSent: () => void }) {
  const [hasPin, setHasPin] = useState<boolean | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [pin, setPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [phase, setPhase] = useState<SendPhase>("form");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/wallet/pin")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("auth"))))
      .then((d: { hasPin: boolean; unlocked: boolean }) => {
        setHasPin(d.hasPin);
        setUnlocked(d.unlocked);
      })
      .catch(() => setHasPin(null));
  }, []);

  async function createPin() {
    setMessage(null);
    const res = await fetch("/api/wallet/pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: newPin }),
    });
    const data = await res.json();
    if (!res.ok) return setMessage(data.error ?? "Could not set PIN.");
    setNewPin("");
    setHasPin(true);
  }

  async function unlock() {
    setMessage(null);
    const res = await fetch("/api/wallet/unlock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    const data = await res.json();
    if (!res.ok) return setMessage(data.error ?? "Incorrect PIN.");
    setPin("");
    setUnlocked(true);
  }

  async function send() {
    setPhase("sending");
    setMessage(null);
    try {
      const res = await fetch("/api/wallet/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, amount: Number(amount) }),
      });
      const data = await res.json();
      if (res.status === 403) {
        setUnlocked(false);
        setPhase("form");
        setMessage("Wallet locked — enter your PIN.");
        return;
      }
      if (!res.ok) {
        setMessage(data.error ?? "Send failed.");
        setPhase("error");
        return;
      }
      setPhase("done");
      setTo("");
      setAmount("");
      onSent();
    } catch {
      setMessage("Network error — please try again.");
      setPhase("error");
    }
  }

  if (hasPin === false) {
    return (
      <div>
        <p className="text-sm font-semibold">Set a wallet PIN</p>
        <p className="mt-1 text-xs text-[var(--text-muted)]">A 4–8 digit PIN confirms your transfers.</p>
        <input
          value={newPin}
          onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ""))}
          type="password"
          inputMode="numeric"
          maxLength={8}
          placeholder="Choose a PIN"
          className="mt-2 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm tracking-[0.3em]"
        />
        <button type="button" onClick={createPin} className="primary-button mt-2 w-full justify-center">
          Set PIN
        </button>
        {message ? <p className="mt-2 text-xs text-[var(--warning-text)]">{message}</p> : null}
      </div>
    );
  }

  if (!unlocked) {
    return (
      <div>
        <p className="text-sm font-semibold">Unlock your wallet</p>
        <p className="mt-1 text-xs text-[var(--text-muted)]">Enter your PIN once — stays unlocked for 5 minutes.</p>
        <input
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
          type="password"
          inputMode="numeric"
          maxLength={8}
          placeholder="Wallet PIN"
          onKeyDown={(e) => e.key === "Enter" && pin && unlock()}
          className="mt-2 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm tracking-[0.3em]"
        />
        <button type="button" onClick={unlock} disabled={!pin} className="primary-button mt-2 w-full justify-center disabled:opacity-50">
          Unlock
        </button>
        {message ? <p className="mt-2 text-xs text-[var(--warning-text)]">{message}</p> : null}
      </div>
    );
  }

  if (phase === "done") {
    return (
      <div className="text-center">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[#17a56b]/15 text-[#17a56b]">
          <Check size={24} />
        </span>
        <p className="mt-2 text-sm font-semibold">Sent!</p>
        <button type="button" onClick={() => setPhase("form")} className="secondary-button mt-3 w-full justify-center">
          Done
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#2775ca]/15 text-[#2775ca]">
          <ArrowUpFromLine size={16} />
        </span>
        <p className="text-sm font-semibold">
          Send <Usdc />
        </p>
      </div>
      <p className="mt-1 flex items-center gap-1 text-xs text-[var(--text-muted)]">
        Balance: <Usdc size={12} /> {balance ?? "…"} · Arc Testnet
      </p>
      <input
        value={to}
        onChange={(e) => setTo(e.target.value)}
        placeholder="Recipient 0x… address"
        className="mt-3 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-xs"
      />
      <input
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        inputMode="decimal"
        placeholder="Amount (USDC)"
        className="mt-2 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm"
      />
      <button
        type="button"
        onClick={send}
        disabled={phase === "sending" || !to || !amount}
        className="primary-button mt-3 w-full justify-center disabled:opacity-50"
      >
        {phase === "sending" ? <Loader2 size={15} className="animate-spin" /> : <ArrowUpFromLine size={15} />}
        {phase === "sending" ? "Sending…" : "Send"}
      </button>
      {message ? <p className="mt-2 text-xs text-[var(--warning-text)]">{message}</p> : null}
    </div>
  );
}

type WalletTx = { id: string; direction: "in" | "out"; amount: string; address: string; state: string; txHash: string | null; date: string };

function HistoryTab({ ownShort }: { ownShort: string | null }) {
  const [txs, setTxs] = useState<WalletTx[] | null>(null);
  const [explorer, setExplorer] = useState("https://testnet.arcscan.app");

  useEffect(() => {
    fetch("/api/wallet/transactions")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("auth"))))
      .then((d: { transactions: WalletTx[]; explorer?: string }) => {
        setTxs(d.transactions);
        if (d.explorer) setExplorer(d.explorer);
      })
      .catch(() => setTxs([]));
  }, []);

  if (txs === null) return <p className="text-sm text-[var(--text-muted)]">Loading…</p>;
  if (txs.length === 0) return <p className="text-sm text-[var(--text-muted)]">No transactions yet.</p>;

  return (
    <div className="max-h-64 space-y-2 overflow-y-auto">
      {txs.map((t) => {
        const inbound = t.direction === "in";
        const other = t.address ? `${t.address.slice(0, 6)}…${t.address.slice(-4)}` : "—";
        return (
          <div key={t.id} className="flex items-center justify-between rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5">
            <span className="flex items-center gap-2">
              <span className={`flex h-7 w-7 items-center justify-center rounded-full ${inbound ? "bg-[#17a56b]/15 text-[#17a56b]" : "bg-[#2775ca]/15 text-[#2775ca]"}`}>
                {inbound ? <ArrowDownLeft size={14} /> : <ArrowUpRight size={14} />}
              </span>
              <span className="text-xs">
                <span className="block font-semibold">{inbound ? "Received" : "Sent"}</span>
                <span className="text-[var(--text-muted)]">
                  {inbound ? "from" : "to"} {other}
                  {t.date ? ` · ${new Date(t.date).toLocaleDateString()}` : ""}
                </span>
              </span>
            </span>
            <span className="flex items-center gap-1.5 text-right">
              <span className={`flex items-center gap-1 text-xs font-semibold ${inbound ? "text-[#17a56b]" : "text-[var(--text)]"}`}>
                {inbound ? "+" : "−"}
                <Usdc size={12} />
                {t.amount}
              </span>
              {t.txHash ? (
                <a href={`${explorer}/tx/${t.txHash}`} target="_blank" rel="noreferrer" aria-label="View on explorer" className="text-[var(--text-muted)] hover:text-[#1d9bf0]">
                  <ExternalLink size={12} />
                </a>
              ) : null}
            </span>
          </div>
        );
      })}
      <p className="pt-1 text-center text-[10px] text-[var(--text-muted)]">Own address {ownShort}</p>
    </div>
  );
}
