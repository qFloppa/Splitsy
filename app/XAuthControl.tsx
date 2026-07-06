"use client";

import { AnimatePresence, motion } from "framer-motion";
import { ArrowDownToLine, ArrowUpFromLine, Check, Copy, ExternalLink, GripVertical, Loader2, Wallet, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { readArcUsdcBalance, billUnitsToUsdc } from "@/lib/bill-split-contracts";

type Me = { id: string; handle: string; name: string | null; avatarUrl: string | null; walletAddress: string | null };

export default function XAuthControl() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [balance, setBalance] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState<"info" | "send" | "receive">("info");
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

  // Read the wallet's testnet USDC balance when the panel opens.
  useEffect(() => {
    if (!open || !me?.walletAddress) return;
    let active = true;
    readArcUsdcBalance(me.walletAddress as `0x${string}`)
      .then((b) => {
        if (active) setBalance(billUnitsToUsdc(b));
      })
      .catch(() => {
        if (active) setBalance(null);
      });
    return () => {
      active = false;
    };
  }, [open, me?.walletAddress]);

  function copyAddress() {
    if (!me?.walletAddress) return;
    void navigator.clipboard.writeText(me.walletAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (loading) {
    return <span className="text-sm text-[var(--text-muted)]">…</span>;
  }

  if (!me) {
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
    <div ref={ref} className="relative flex items-center gap-2">
      <a href="/bills" className="text-sm font-semibold text-[#1d9bf0]">
        Bills
      </a>
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex items-center gap-2">
        {me.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={me.avatarUrl} alt="" width={24} height={24} className="rounded-full" />
        ) : null}
        <span className="text-sm font-semibold">@{me.handle}</span>
      </button>
      <form action="/api/auth/logout" method="post">
        <button type="submit" className="text-sm text-[var(--text-muted)] underline">
          Log out
        </button>
      </form>

      <AnimatePresence>
        {open ? (
          <motion.div
            drag
            dragMomentum={false}
            dragElastic={0.12}
            dragConstraints={{ left: -520, right: 40, top: -20, bottom: 520 }}
            initial={{ opacity: 0, scale: 0.9, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 8 }}
            transition={{ type: "spring", stiffness: 340, damping: 26 }}
            whileDrag={{ scale: 1.03, boxShadow: "0 24px 60px rgba(0,0,0,0.45)" }}
            className="absolute right-0 top-full z-[70] mt-2 w-80 select-none rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-muted)] shadow-2xl"
          >
            {/* Drag handle / title bar */}
            <div className="flex cursor-grab items-center justify-between rounded-t-[var(--radius)] border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2 active:cursor-grabbing">
              <span className="flex items-center gap-1.5 text-xs font-semibold text-[var(--text-muted)]">
                <GripVertical size={14} />
                Splitsy wallet
              </span>
              <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="text-[var(--text-muted)] hover:text-[var(--text)]">
                <X size={15} />
              </button>
            </div>

            <div className="p-4">
              <div className="flex items-center gap-3">
                {me.avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={me.avatarUrl} alt="" width={36} height={36} className="rounded-full" />
                ) : null}
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">@{me.handle}</p>
                  {me.name ? <p className="truncate text-xs text-[var(--text-muted)]">{me.name}</p> : null}
                </div>
              </div>

              {/* Tab bar */}
              <div className="mt-3 grid grid-cols-3 gap-1 rounded-full bg-[var(--surface)] p-1 text-xs font-semibold">
                {(["info", "send", "receive"] as const).map((t) => (
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
                      <p className="text-sm font-semibold">Your Splitsy wallet</p>
                    </div>
                    <p className="mt-2 text-sm text-[var(--text-muted)]">
                      A real Circle developer-controlled wallet on <strong className="text-[var(--text)]">Arc Testnet</strong>,
                      created just for <strong className="text-[var(--text)]">@{me.handle}</strong>. Splitsy manages it so
                      you can pay bills with no crypto setup.
                    </p>

                    {me.walletAddress ? (
                      <>
                        <div className="mt-3 flex items-center justify-between gap-2 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5">
                          <code className="text-xs">{short}</code>
                          <button
                            type="button"
                            onClick={copyAddress}
                            className="flex items-center gap-1 text-xs font-semibold text-[#1d9bf0]"
                          >
                            {copied ? <Check size={13} /> : <Copy size={13} />}
                            {copied ? "Copied" : "Copy"}
                          </button>
                        </div>
                        <p className="mt-2 text-sm">
                          Balance: <strong className="amount-text">{balance ?? "…"} USDC</strong>
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
                        <p className="mt-1.5 text-xs text-[var(--text-muted)]">Pick Arc Testnet and paste the address above.</p>
                      </>
                    ) : (
                      <p className="mt-2 text-sm text-[var(--text-muted)]">Your wallet is being created — refresh in a moment.</p>
                    )}
                  </>
                ) : tab === "send" ? (
                  <SendTab
                    balance={balance}
                    onSent={() => {
                      // Refresh balance after a send.
                      if (me.walletAddress) {
                        readArcUsdcBalance(me.walletAddress as `0x${string}`)
                          .then((b) => setBalance(billUnitsToUsdc(b)))
                          .catch(() => {});
                      }
                    }}
                  />
                ) : (
                  <ReceiveTab address={me.walletAddress} short={short} copied={copied} onCopy={copyAddress} />
                )}
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function ReceiveTab({
  address,
  short,
  copied,
  onCopy,
}: {
  address: string | null;
  short: string | null;
  copied: boolean;
  onCopy: () => void;
}) {
  if (!address) {
    return <p className="text-sm text-[var(--text-muted)]">Your wallet is being created — refresh in a moment.</p>;
  }
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#17a56b]/15 text-[#17a56b]">
          <ArrowDownToLine size={16} />
        </span>
        <p className="text-sm font-semibold">Receive USDC</p>
      </div>
      <p className="mt-2 text-sm text-[var(--text-muted)]">
        Share your address to receive USDC on <strong className="text-[var(--text)]">Arc Testnet</strong>.
      </p>
      <div className="mt-3 break-all rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 text-xs">
        {address}
      </div>
      <button
        type="button"
        onClick={onCopy}
        className="mt-2 flex items-center gap-1 text-xs font-semibold text-[#1d9bf0]"
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
        {copied ? "Copied" : `Copy ${short}`}
      </button>
    </div>
  );
}

type SendPhase = "form" | "sending" | "done" | "error";

function SendTab({ balance, onSent }: { balance: string | null; onSent: () => void }) {
  const [hasPin, setHasPin] = useState<boolean | null>(null);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [pin, setPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [phase, setPhase] = useState<SendPhase>("form");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/wallet/pin")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("auth"))))
      .then((d: { hasPin: boolean }) => {
        if (active) setHasPin(d.hasPin);
      })
      .catch(() => {
        if (active) setHasPin(null);
      });
    return () => {
      active = false;
    };
  }, []);

  async function createPin() {
    setMessage(null);
    const res = await fetch("/api/wallet/pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: newPin }),
    });
    const data = await res.json();
    if (!res.ok) {
      setMessage(data.error ?? "Could not set PIN.");
      return;
    }
    setNewPin("");
    setHasPin(true);
  }

  async function send() {
    setPhase("sending");
    setMessage(null);
    try {
      const res = await fetch("/api/wallet/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, amount: Number(amount), pin }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage(data.error ?? "Send failed.");
        setPhase("error");
        return;
      }
      setPhase("done");
      setTo("");
      setAmount("");
      setPin("");
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
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          A 4–8 digit PIN confirms sends from your wallet. (Demo safeguard — Splitsy still manages the keys.)
        </p>
        <input
          value={newPin}
          onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ""))}
          inputMode="numeric"
          maxLength={8}
          placeholder="Choose a PIN"
          className="mt-2 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm"
        />
        <button type="button" onClick={createPin} className="primary-button mt-2 w-full justify-center">
          Set PIN
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
        <p className="text-sm font-semibold">Send USDC</p>
      </div>
      <p className="mt-1 text-xs text-[var(--text-muted)]">Balance: {balance ?? "…"} USDC · Arc Testnet</p>

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
      <input
        value={pin}
        onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
        inputMode="numeric"
        maxLength={8}
        placeholder="Wallet PIN"
        className="mt-2 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm"
      />
      <button
        type="button"
        onClick={send}
        disabled={phase === "sending" || !to || !amount || !pin}
        className="primary-button mt-3 w-full justify-center disabled:opacity-50"
      >
        {phase === "sending" ? <Loader2 size={15} className="animate-spin" /> : <ArrowUpFromLine size={15} />}
        {phase === "sending" ? "Sending…" : "Send"}
      </button>
      {message ? <p className="mt-2 text-xs text-[var(--warning-text)]">{message}</p> : null}
    </div>
  );
}
