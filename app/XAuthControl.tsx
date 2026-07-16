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
  KeyRound,
  Loader2,
  LogOut,
  RefreshCw,
  Wallet,
  X,
} from "lucide-react";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { readArcUsdcBalance, billUnitsToUsdc } from "@/lib/bill-split-contracts";
import { providerDisplay } from "@/lib/provider-display";
import type { IdentityProvider } from "@/lib/types";
import { ProviderIcon } from "./ProviderTag";

type Me = { id: string; provider?: IdentityProvider | null; handle: string; name: string | null; avatarUrl: string | null; walletAddress: string | null };
type Tab = "info" | "send" | "receive" | "history";

function Usdc({ size = 14 }: { size?: number }) {
  return <Image src="/usd-coin-usdc-seeklogo.png" alt="USDC" width={size} height={size} className="inline-block align-text-bottom" />;
}

// The signed-in user's own handle with its platform badge and correct prefix
// (X carries "@", Discord/Email don't), linking to the X profile when there is
// one. Mirrors how tagged people render elsewhere via ProviderTag.
function OwnHandle({ me, badge = 13 }: { me: Me; badge?: number }) {
  const d = providerDisplay({ provider: me.provider, handle: me.handle, avatarUrl: me.avatarUrl });
  const inner = (
    <>
      <ProviderIcon provider={d.provider} size={badge} />
      <strong className="text-[var(--text)]">
        {d.prefix}
        {d.label}
      </strong>
    </>
  );
  if (d.profileUrl) {
    return (
      <a href={d.profileUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 align-middle hover:underline">
        {inner}
      </a>
    );
  }
  return <span className="inline-flex items-center gap-1 align-middle">{inner}</span>;
}

export default function XAuthControl() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [balance, setBalance] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState<Tab>("info");
  const [hasPin, setHasPin] = useState<boolean | null>(null);
  // Whether the 5-minute unlock window is currently open. Checked every time
  // the panel opens so the unlock gate is the first thing a locked user sees —
  // unlocking here is what lets Pay/Claim buttons elsewhere go through.
  const [unlocked, setUnlocked] = useState<boolean | null>(null);
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

  // Whether the user has chosen a wallet PIN yet, and whether the wallet is
  // currently unlocked. Until a PIN exists, the panel shows nothing but the
  // "choose a PIN" gate; with a PIN but locked, the unlock gate comes first —
  // a PIN unlock is required before any wallet action. Re-checked every time
  // the panel opens because the unlock window expires after 5 minutes.
  useEffect(() => {
    if (!me || !open) return;
    let active = true;
    fetch("/api/wallet/pin")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("auth"))))
      .then((d: { hasPin: boolean; unlocked: boolean }) => {
        if (active) {
          setHasPin(d.hasPin);
          setUnlocked(d.unlocked);
        }
      })
      .catch(() => {
        if (active) {
          setHasPin(null);
          setUnlocked(null);
        }
      });
    return () => {
      active = false;
    };
  }, [me, open]);

  async function refreshBalance() {
    if (!me?.walletAddress) return;
    setRefreshing(true);
    try {
      setBalance(billUnitsToUsdc(await readArcUsdcBalance(me.walletAddress as `0x${string}`)));
    } catch {
      setBalance(null);
    } finally {
      setRefreshing(false);
    }
  }

  // After a send the on-chain balance lags a block or two behind the tx, so a
  // single read returns the old total. Poll until it moves (or we run out of
  // tries) so the panel reflects the deducted amount on its own.
  async function refreshBalanceAfterSend() {
    if (!me?.walletAddress) return;
    const addr = me.walletAddress as `0x${string}`;
    setRefreshing(true);
    let prev: bigint | null = null;
    try {
      prev = await readArcUsdcBalance(addr);
      setBalance(billUnitsToUsdc(prev));
    } catch {
      /* ignore; keep polling */
    }
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const next = await readArcUsdcBalance(addr);
        setBalance(billUnitsToUsdc(next));
        if (prev !== null && next !== prev) break;
      } catch {
        /* transient RPC error; try again */
      }
    }
    setRefreshing(false);
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

  // Signed out (or still loading): render nothing. The header's SignInMenu
  // provides the sign-in entry point; this widget is only for signed-in users.
  if (loading || !me) {
    return null;
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
                  <p className="flex items-center gap-1 truncate text-sm font-semibold">
                    <OwnHandle me={me} />
                  </p>
                  <p className="flex items-center gap-1 text-xs text-[var(--text-muted)]">
                    <Usdc size={12} /> {balance ?? "…"} USDC
                    <button
                      type="button"
                      onClick={refreshBalance}
                      disabled={refreshing}
                      aria-label="Refresh balance"
                      className="ml-0.5 text-[var(--text-muted)] transition hover:text-[var(--text)] disabled:opacity-60"
                    >
                      <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} />
                    </button>
                  </p>
                </div>
              </div>

              {hasPin === false ? (
                <SetPinGate
                  onDone={() => {
                    setHasPin(true);
                    setUnlocked(true);
                  }}
                />
              ) : hasPin === true && unlocked === false ? (
                <UnlockGate onUnlocked={() => setUnlocked(true)} />
              ) : (
                <>
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
                      <OwnHandle me={me} />. Pay and get paid in USDC — no crypto setup needed.
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
                  <SendTab balance={balance} onSent={refreshBalanceAfterSend} />
                ) : tab === "receive" ? (
                  <ReceiveTab address={me.walletAddress} short={short} copied={copied} onCopy={copyAddress} />
                ) : (
                  <HistoryTab ownShort={short} />
                )}
              </div>
                </>
              )}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

// First-run gate: the user must choose a wallet PIN before doing anything else.
// Entered twice so a typo can't lock them out of a PIN they didn't mean to set.
function SetPinGate({ onDone }: { onDone: () => void }) {
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const valid = /^\d{4,8}$/.test(pin);
  const match = pin === confirm;

  async function create() {
    setMessage(null);
    if (!valid) return setMessage("PIN must be 4–8 digits.");
    if (!match) return setMessage("The PINs don't match — try again.");
    setBusy(true);
    try {
      const res = await fetch("/api/wallet/pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(data.error ?? "Could not set PIN.");
        setBusy(false);
        return;
      }
      // Unlock right away with the PIN just chosen so the user isn't asked to
      // re-enter it on the very next screen.
      await fetch("/api/wallet/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      }).catch(() => {});
      onDone();
    } catch {
      setMessage("Network error — please try again.");
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 border-t border-[var(--border)] pt-3">
      <div className="flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#2775ca]/15 text-[#2775ca]">
          <KeyRound size={16} />
        </span>
        <p className="text-sm font-semibold">Choose a wallet PIN</p>
      </div>
      <p className="mt-2 text-xs text-[var(--text-muted)]">
        Set a 4–8 digit PIN before using your wallet. You&apos;ll need it to send USDC. Enter it twice to confirm.
      </p>
      <input
        value={pin}
        onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
        type="password"
        inputMode="numeric"
        maxLength={8}
        autoFocus
        placeholder="Choose a PIN"
        className="mt-3 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm tracking-[0.3em]"
      />
      <input
        value={confirm}
        onChange={(e) => setConfirm(e.target.value.replace(/\D/g, ""))}
        type="password"
        inputMode="numeric"
        maxLength={8}
        placeholder="Confirm PIN"
        onKeyDown={(e) => e.key === "Enter" && valid && match && !busy && create()}
        className="mt-2 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm tracking-[0.3em]"
      />
      {confirm.length > 0 && !match ? (
        <p className="mt-2 text-xs text-[var(--warning-text)]">The PINs don&apos;t match yet.</p>
      ) : null}
      <button
        type="button"
        onClick={create}
        disabled={busy || !valid || !match}
        className="primary-button mt-3 w-full justify-center disabled:opacity-50"
      >
        {busy ? <Loader2 size={15} className="animate-spin" /> : <KeyRound size={15} />}
        Set PIN
      </button>
      {message ? <p className="mt-2 text-xs text-[var(--warning-text)]">{message}</p> : null}
    </div>
  );
}

// Opening-the-panel gate: when a PIN exists but the 5-minute unlock window has
// lapsed, the wallet unlocks here before anything else — so Pay/Claim buttons
// elsewhere in the app work right after closing the panel, and the Send tab
// never needs its own unlock prompt.
function UnlockGate({ onUnlocked }: { onUnlocked: () => void }) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function unlock() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/wallet/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(data.error ?? "Incorrect PIN.");
        setBusy(false);
        return;
      }
      onUnlocked();
    } catch {
      setMessage("Network error — please try again.");
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 border-t border-[var(--border)] pt-3">
      <div className="flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#2775ca]/15 text-[#2775ca]">
          <KeyRound size={16} />
        </span>
        <p className="text-sm font-semibold">Unlock your wallet</p>
      </div>
      <p className="mt-2 text-xs text-[var(--text-muted)]">
        Enter your PIN once — stays unlocked for 5 minutes, for paying, claiming, and sending.
      </p>
      <input
        value={pin}
        onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
        type="password"
        inputMode="numeric"
        maxLength={8}
        autoFocus
        placeholder="Wallet PIN"
        onKeyDown={(e) => e.key === "Enter" && pin && !busy && unlock()}
        className="mt-3 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm tracking-[0.3em]"
      />
      <button
        type="button"
        onClick={unlock}
        disabled={busy || !pin}
        className="primary-button mt-3 w-full justify-center disabled:opacity-50"
      >
        {busy ? <Loader2 size={15} className="animate-spin" /> : <KeyRound size={15} />}
        Unlock
      </button>
      {message ? <p className="mt-2 text-xs text-[var(--warning-text)]">{message}</p> : null}
    </div>
  );
}

function ReceiveTab({ address, short, copied, onCopy }: { address: string | null; short: string | null; copied: boolean; onCopy: () => void }) {  if (!address) return <p className="text-sm text-[var(--text-muted)]">Your wallet is being created — refresh in a moment.</p>;
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
  const [unlocked, setUnlocked] = useState(false);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [pin, setPin] = useState("");
  const [phase, setPhase] = useState<SendPhase>("form");
  const [message, setMessage] = useState<string | null>(null);
  const [sentTxUrl, setSentTxUrl] = useState<string | null>(null);

  // A PIN always exists by the time this tab renders (the panel gates on it), so
  // we only need the current unlock state — sending still requires unlocking.
  useEffect(() => {
    fetch("/api/wallet/pin")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("auth"))))
      .then((d: { unlocked: boolean }) => setUnlocked(d.unlocked))
      .catch(() => {});
  }, []);

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
      // The on-chain hash lands a few seconds after Circle accepts the tx; poll
      // the history endpoint to surface an explorer link once it's available.
      if (data.txId) {
        for (let i = 0; i < 6; i++) {
          await new Promise((r) => setTimeout(r, 2500));
          try {
            const h = await fetch("/api/wallet/transactions").then((r) => r.json());
            const match = (h.transactions as WalletTx[] | undefined)?.find((t) => t.id === data.txId);
            if (match?.txHash) {
              setSentTxUrl(`${h.explorer ?? "https://testnet.arcscan.app"}/tx/${match.txHash}`);
              break;
            }
          } catch {
            break;
          }
        }
      }
    } catch {
      setMessage("Network error — please try again.");
      setPhase("error");
    }
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
        {sentTxUrl ? (
          <a
            href={sentTxUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-[#1d9bf0]"
          >
            <ExternalLink size={12} /> View transaction
          </a>
        ) : (
          <p className="mt-2 flex items-center justify-center gap-1 text-xs text-[var(--text-muted)]">
            <Loader2 size={11} className="animate-spin" /> confirming on Arc…
          </p>
        )}
        <button
          type="button"
          onClick={() => {
            setSentTxUrl(null);
            setPhase("form");
          }}
          className="secondary-button mt-3 w-full justify-center"
        >
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
