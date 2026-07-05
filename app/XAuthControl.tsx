"use client";

import { AnimatePresence, motion } from "framer-motion";
import { Copy, Check, ExternalLink, GripVertical, Wallet, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { readArcUsdcBalance, billUnitsToUsdc } from "@/lib/bill-split-contracts";

type Me = { id: string; handle: string; name: string | null; avatarUrl: string | null; walletAddress: string | null };

export default function XAuthControl() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [balance, setBalance] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
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

              <div className="mt-3 border-t border-[var(--border)] pt-3">
                <div className="flex items-center gap-2">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#2775ca]/15 text-[#2775ca]">
                    <Wallet size={16} />
                  </span>
                  <p className="text-sm font-semibold">Your Splitsy wallet</p>
                </div>
                <p className="mt-2 text-sm text-[var(--text-muted)]">
                  A real Circle developer-controlled wallet on <strong className="text-[var(--text)]">Arc Testnet</strong>,
                  created just for <strong className="text-[var(--text)]">@{me.handle}</strong>. Splitsy manages it so you
                  can pay bills with no crypto setup.
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
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
