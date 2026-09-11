"use client";

import { AnimatePresence, motion, useDragControls } from "framer-motion";
import { ArrowUpRight, Check, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { waitForCircleTxUrl } from "@/lib/arc-explorer";
import { readArcUsdcBalance, billUnitsToUsdc } from "@/lib/bill-split-contracts";
import { providerDisplay } from "@/lib/provider-display";
import type { AccountProvider } from "@/lib/types";
import ExportTab from "./ExportTab";
import { ProviderIcon } from "./ProviderTag";
import { signedSend, type SignedSendResult } from "./signed-send";

type Me = { id: string; provider?: AccountProvider | null; handle: string; name: string | null; avatarUrl: string | null; walletAddress: string | null; custodian?: "Circle" | "Privy" };
type Tab = "info" | "send" | "receive" | "history" | "export";

// What GET /api/wallet/export answers, read here for a second purpose: the SEND
// tab needs the wallet id, the app id and the recorded owner key to build and sign
// an authorization payload. Deliberately the same shape app/ExportTab.tsx declares,
// because it is the same route — only `state === "enabled"` matters to this file,
// and anything else leaves sending exactly as it was.
type ExportStatus = {
  state: "not_enabled" | "enabled" | "needs_restore";
  walletId: string;
  appId: string;
  address: string;
  exportOwnerKey: string | null;
};

// `export` is NOT in this list. It is appended per-render below, only on the
// Privy stack: a Circle wallet's key cannot be exported, so the route answers
// 404 and the tab's whole content would be the words "Export is not available
// on this wallet stack." A tab that can only say that should not be a tab.
const TABS: { id: Tab; label: string }[] = [
  { id: "info", label: "wallet" },
  { id: "send", label: "send" },
  { id: "receive", label: "receive" },
  { id: "history", label: "history" },
];

// "USDC" is a word here, not the seeklogo PNG this panel used to inline eight
// times. Every other surface in the app already says it as text — this file was
// the only one left importing the image, and eight 12px logos in a 352px column
// is a currency symbol used as decoration.
function Unit() {
  return <span className="wallet-unit">USDC</span>;
}

// The signed-in user's own handle with its platform mark and correct prefix
// (X carries "@", Discord/Email don't), linking to the X profile when there is
// one. Mirrors how tagged people render elsewhere via ProviderTag.
function OwnHandle({ me, badge = 13 }: { me: Me; badge?: number }) {
  const d = providerDisplay({ provider: me.provider, handle: me.handle, avatarUrl: me.avatarUrl });
  const inner = (
    <>
      <ProviderIcon provider={d.provider} size={badge} />
      {d.prefix}
      {d.label}
    </>
  );
  if (d.profileUrl) {
    return (
      <a href={d.profileUrl} target="_blank" rel="noreferrer" className="wallet-handle">
        {inner}
      </a>
    );
  }
  return <span className="wallet-handle">{inner}</span>;
}

// A caps word that names a value below it. The panel's every heading is one of
// these — the four icons in tinted circles that used to sit beside them are gone
// with the rest of the pre-redesign skin.
function Label({ children }: { children: React.ReactNode }) {
  return <p className="settle-label">{children}</p>;
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
  // Only the head rail drags. See .wallet-grip: with `drag` on the whole pane a
  // pointer-down in the amount field moved the window instead of typing, and the
  // `select-none` that came with it meant the address could not be selected by
  // hand at all.
  const dragControls = useDragControls();

  // It claims role="dialog", so Escape has to close it — a panel that says it is
  // a dialog and then swallows the one key every dialog answers to is worse than
  // one that never said so.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

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
    // Reading the chain is an external-system sync; the setState the linter sees
    // is refreshBalance's own loading flag, which has to flip before the await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open && me?.walletAddress) void refreshBalance();
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
  //
  // Also nothing for an account that signed in AS a browser wallet. This panel
  // is the Splitsy DCW — its balance, its send/receive, its PIN — and that
  // wallet is an implementation detail to someone who already holds their own
  // keys: they never funded it and nothing routes them to it. SignInMenu shows
  // their address and the way out instead.
  if (loading || !me || me.provider === "wallet") {
    return null;
  }

  return (
    <>
      {/* The trigger: the word that names the control, and the avatar that says
          whose it is. The old version was a blue-ringed circle carrying a wallet
          glyph badge that re-said "wallet" a second time over the first. */}
      <motion.button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Open your wallet"
        aria-expanded={open}
        className="wallet-hail"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
      >
        <span className="wallet-hail-word">wallet</span>
        <span className="wallet-hail-mark">
          {me.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={me.avatarUrl} alt="" width={42} height={42} />
          ) : (
            <span className="wallet-initial" aria-hidden>
              {me.handle.replace(/^@/, "").charAt(0) || "S"}
            </span>
          )}
        </span>
      </motion.button>

      <AnimatePresence>
        {open ? (
          <motion.div
            drag
            dragListener={false}
            dragControls={dragControls}
            dragMomentum={false}
            dragElastic={0.12}
            initial={{ opacity: 0, y: 14, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 14, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 340, damping: 28 }}
            className="wallet-panel"
            role="dialog"
            aria-label="Your wallet"
          >
            <div
              className="wallet-grip"
              onPointerDown={(e) => {
                // The rail carries two controls of its own; a pointer-down on
                // either has to reach them rather than arm a window drag.
                if ((e.target as HTMLElement).closest("button")) return;
                dragControls.start(e);
              }}
            >
              <span className="settle-label">wallet</span>
              <span className="wallet-grip-end">
                <form action="/api/auth/logout" method="post">
                  <button type="submit" className="iou-provider">
                    sign out
                  </button>
                </form>
                <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="wallet-x">
                  <X size={15} />
                </button>
              </span>
            </div>

            <div className="wallet-body">
              <div className="wallet-who">
                {me.avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={me.avatarUrl} alt="" width={27} height={27} className="wallet-who-avatar" />
                ) : null}
                <span className="wallet-who-name">
                  <OwnHandle me={me} />
                </span>
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
                  {/* The figure, once. It used to be printed twice — a caption
                      beside the handle and again inside the Wallet tab — which is
                      two answers to one question on a 352px column. */}
                  <div className="wallet-band">
                    <div className="iou-rail">
                      <span>balance</span>
                      <button type="button" onClick={refreshBalance} disabled={refreshing}>
                        {refreshing ? "reading…" : "refresh"}
                      </button>
                    </div>
                    <p className="wallet-figure">
                      {balance ?? "—"}
                      <Unit />
                    </p>
                  </div>

                  <div className="wallet-tabs">
                    {(me.custodian === "Privy" ? [...TABS, { id: "export" as Tab, label: "export" }] : TABS).map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => setTab(t.id)}
                        aria-current={tab === t.id ? "true" : undefined}
                        className="iou-provider bill-toggle"
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>

                  <div className="wallet-tab-body">
                    {tab === "info" ? (
                      <>
                        <p className="wallet-note">
                          A Splitsy wallet on <b>Arc Testnet</b>, tied to <OwnHandle me={me} />. Pay and get paid in
                          USDC — no crypto setup needed.
                        </p>
                        {me.walletAddress ? (
                          <div className="wallet-band">
                            <div className="iou-rail">
                              <span>address</span>
                              <button type="button" onClick={copyAddress}>
                                {copied ? "copied" : "copy"}
                              </button>
                            </div>
                            <p className="wallet-proof">{me.walletAddress}</p>
                            {me.custodian === "Privy" ? (
                              <p className="wallet-note">
                                <b>Held by Privy.</b> Your assets are held by Privy, the custodian.
                                Splitsy is the app that operates this wallet and can move assets on
                                your behalf. Privy is a SOC&nbsp;2–audited custody provider,
                                independently reviewed by Cure53, Zellic and Doyensec, with a public
                                bug bounty and keys that are encrypted and segmented so no single
                                party holds a whole key.{" "}
                                <a
                                  href="https://privy.io/security"
                                  target="_blank"
                                  rel="noreferrer"
                                  className="wallet-handle"
                                  aria-label="privy.io/security (opens in a new tab)"
                                >
                                  privy.io/security
                                </a>
                                . Until you set an export password, Splitsy can <b>also</b> export
                                this wallet&rsquo;s private key itself — set one in the{" "}
                                <b>export</b> tab, and the sends you make from here are signed by
                                you rather than by Splitsy.
                              </p>
                            ) : null}
                            <a
                              href="https://faucet.circle.com"
                              target="_blank"
                              rel="noreferrer"
                              className="settle-trigger wallet-out"
                            >
                              add test USDC
                              <ArrowUpRight className="lp-row-out" size={13} />
                            </a>
                          </div>
                        ) : (
                          <p className="wallet-note">Your wallet is being created — refresh in a moment.</p>
                        )}
                      </>
                    ) : tab === "send" ? (
                      <SendTab balance={balance} onSent={refreshBalanceAfterSend} walletAddress={me.walletAddress} />
                    ) : tab === "receive" ? (
                      <ReceiveTab address={me.walletAddress} copied={copied} onCopy={copyAddress} />
                    ) : tab === "export" && me.walletAddress ? (
                      <ExportTab address={me.walletAddress} />
                    ) : (
                      <HistoryTab />
                    )}
                  </div>
                </>
              )}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
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
    <div className="wallet-band">
      <Label>choose a wallet PIN</Label>
      <p className="wallet-note">
        Set a 4–8 digit PIN before using your wallet. You&apos;ll need it to send USDC. Enter it twice to confirm.
      </p>
      <div className="wallet-line" data-pin>
        <input
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
          type="password"
          inputMode="numeric"
          maxLength={8}
          autoFocus
          aria-label="Choose a PIN"
          placeholder="••••"
        />
      </div>
      <div className="wallet-line" data-pin>
        <input
          value={confirm}
          onChange={(e) => setConfirm(e.target.value.replace(/\D/g, ""))}
          type="password"
          inputMode="numeric"
          maxLength={8}
          aria-label="Confirm PIN"
          placeholder="••••"
          onKeyDown={(e) => e.key === "Enter" && valid && match && !busy && create()}
        />
      </div>
      {confirm.length > 0 && !match ? (
        <p className="wallet-note" data-tone="warn">
          The PINs don&apos;t match yet.
        </p>
      ) : null}
      <button type="button" onClick={create} disabled={busy || !valid || !match} className="settle-action">
        {busy ? "…" : "set PIN"} ›
      </button>
      {message ? (
        <p className="wallet-note" data-tone="warn" role="status">
          {message}
        </p>
      ) : null}
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
    <div className="wallet-band">
      <Label>unlock your wallet</Label>
      <p className="wallet-note">
        Enter your PIN once — stays unlocked for 5 minutes, for paying, claiming, and sending.
      </p>
      <div className="wallet-line" data-pin>
        <input
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
          type="password"
          inputMode="numeric"
          maxLength={8}
          autoFocus
          aria-label="Wallet PIN"
          placeholder="••••"
          onKeyDown={(e) => e.key === "Enter" && pin && !busy && unlock()}
        />
      </div>
      <button type="button" onClick={unlock} disabled={busy || !pin} className="settle-action">
        {busy ? "…" : "unlock"} ›
      </button>
      {message ? (
        <p className="wallet-note" data-tone="warn" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}

function ReceiveTab({ address, copied, onCopy }: { address: string | null; copied: boolean; onCopy: () => void }) {
  if (!address) return <p className="wallet-note">Your wallet is being created — refresh in a moment.</p>;
  return (
    <div>
      <div className="iou-rail">
        <span>receive to</span>
        <button type="button" onClick={onCopy}>
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <p className="wallet-proof">{address}</p>
      <p className="wallet-note">
        Share this address to receive USDC on <b>Arc Testnet</b>.
      </p>
    </div>
  );
}

type SendPhase = "form" | "sending" | "done" | "error";

function SendTab({ balance, onSent, walletAddress }: { balance: string | null; onSent: () => void; walletAddress: string | null }) {
  const [unlocked, setUnlocked] = useState(false);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [pin, setPin] = useState("");
  const [phase, setPhase] = useState<SendPhase>("form");
  const [message, setMessage] = useState<string | null>(null);
  const [sentTxUrl, setSentTxUrl] = useState<string | null>(null);
  const [signedBy, setSignedBy] = useState<"you" | "splitsy" | null>(null);
  // Non-null only when this wallet has export enabled AND the owner key is not yet
  // held for this session — the password is derived once and then the field is
  // hidden. See app/session-owner-key.ts for why the key is not React state.
  const [exportStatus, setExportStatus] = useState<ExportStatus | null>(null);
  const [ownerPassword, setOwnerPassword] = useState("");
  const [ownerKey, setOwnerKey] = useState<Uint8Array | null>(null);

  // A PIN always exists by the time this tab renders (the panel gates on it), so
  // we only need the current unlock state — sending still requires unlocking.
  useEffect(() => {
    fetch("/api/wallet/pin")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("auth"))))
      .then((d: { unlocked: boolean }) => setUnlocked(d.unlocked))
      .catch(() => {});
  }, []);

  // Whether this user can sign for themselves. A 404 is the Circle stack (the route
  // does not exist as a capability there) and any other failure leaves the send
  // working the old way, so this never surfaces an error — it only decides whether
  // to offer the stronger path.
  useEffect(() => {
    if (!walletAddress) return;
    fetch("/api/wallet/export")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: ExportStatus | null) => {
        if (d?.state !== "enabled") return;
        setExportStatus(d);
        // Already derived earlier this session: skip the prompt entirely. Read from
        // the module, not from state, because a tab switch unmounts this component
        // and remounts it with fresh state.
        void import("./session-owner-key").then((m) => setOwnerKey(m.ownerKeyFor(d.address)));
      })
      .catch(() => {});
  }, [walletAddress]);

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

  // Derive the owner key from the export password, once per session. The ~1s PBKDF2
  // is the price of the key never being held longer than the tab; it is paid here
  // rather than per send, which is the trade recorded in app/session-owner-key.ts.
  async function deriveOwnerKey() {
    if (!exportStatus) return;
    setMessage(null);
    try {
      const crypto = await import("@/lib/export-crypto");
      const key = await crypto.deriveOwnerSecretKey(ownerPassword, exportStatus.address);
      const publicKey = await crypto.ownerPublicKeySpki(key);
      // The local pre-check, same one ExportTab runs: a mistyped password fails
      // HERE, with no request made. Possible only because the PUBLIC half of the
      // credential is recorded server-side.
      if (exportStatus.exportOwnerKey && exportStatus.exportOwnerKey !== publicKey) {
        setMessage("That password doesn't match this wallet's export credential.");
        return;
      }
      const session = await import("./session-owner-key");
      session.rememberOwnerKey(exportStatus.address, key);
      setOwnerKey(key);
      setOwnerPassword("");
    } catch {
      setMessage("Could not derive your key from that password. Please try again.");
    }
  }

  async function send() {
    setPhase("sending");
    setMessage(null);
    try {
      // Holding the owner key is what makes this a USER-signed send. Without it —
      // no export password set, or the Circle stack, or the derivation skipped —
      // this falls through to the server-signed path, unchanged.
      //
      // signedSend is the shared prepare/sign/relay round trip (app/signed-send.ts),
      // the same one the debt and bill panels use. It reads the key from the session
      // module rather than taking it as an argument, so nothing here holds it.
      const outcome =
        ownerKey && exportStatus
          ? await signedSend("/api/wallet/send", exportStatus.address, { to, amount: Number(amount) })
          : await sendSignedBySplitsy();

      if (outcome.ok === false && outcome.locked) {
        setUnlocked(false);
        setPhase("form");
        setMessage("Wallet locked — enter your PIN.");
        return;
      }
      if (!outcome.ok) {
        setMessage(outcome.error === "unlock_owner_key" ? "Enter your export password to sign this send." : outcome.error);
        setPhase("error");
        return;
      }
      setSignedBy(outcome.data.signedBy === "you" ? "you" : "splitsy");
      setPhase("done");
      setTo("");
      setAmount("");
      onSent();
      // The on-chain hash lands a few seconds after Circle accepts the tx; poll
      // the history endpoint to surface an explorer link once it's available.
      if (typeof outcome.data.txId === "string") {
        const url = await waitForCircleTxUrl(outcome.data.txId);
        if (url) setSentTxUrl(url);
      }
    } catch {
      setMessage("Network error — please try again.");
      setPhase("error");
    }
  }

  // The unchanged path: ask the server to sign and send with its own quorum. Every
  // user whose wallet is still custodial takes this one. Shaped like signedSend's
  // result so the handling above is one branch rather than two.
  async function sendSignedBySplitsy(): Promise<SignedSendResult> {
    const res = await fetch("/api/wallet/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, amount: Number(amount) }),
    });
    const body = await res.json().catch(() => ({}));
    return res.ok
      ? { ok: true, data: body }
      : { ok: false, error: body.error ?? "Send failed.", status: res.status, locked: res.status === 403 };
  }

  if (!unlocked) {
    return (
      <div>
        <Label>unlock to send</Label>
        <p className="wallet-note">Enter your PIN once — stays unlocked for 5 minutes.</p>
        <div className="wallet-line" data-pin>
          <input
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
            type="password"
            inputMode="numeric"
            maxLength={8}
            aria-label="Wallet PIN"
            placeholder="••••"
            onKeyDown={(e) => e.key === "Enter" && pin && unlock()}
          />
        </div>
        <button type="button" onClick={unlock} disabled={!pin} className="settle-action">
          unlock ›
        </button>
        {message ? (
          <p className="wallet-note" data-tone="warn" role="status">
            {message}
          </p>
        ) : null}
      </div>
    );
  }

  if (phase === "done") {
    return (
      <div>
        <Label>sent</Label>
        <p className="wallet-figure" data-tone="ok">
          <span className="settle-tick">
            <Check strokeWidth={3} />
          </span>
        </p>
        {/* WHICH SIGNER, out loud. A user who set an export password did so to stop
            Splitsy moving their money, and a silent fallback to the server-signed
            path would leave that unverifiable by the person it is for. */}
        {signedBy ? (
          <p className="wallet-note">
            {signedBy === "you"
              ? "Signed by your export password — Splitsy did not authorise this transfer."
              : "Signed by Splitsy. Set an export password to sign your own sends."}
          </p>
        ) : null}
        {sentTxUrl ? (
          <a href={sentTxUrl} target="_blank" rel="noreferrer" className="settle-trigger wallet-out">
            view transaction
            <ArrowUpRight className="lp-row-out" size={13} />
          </a>
        ) : (
          <p className="wallet-note">
            <Loader2 size={11} className="animate-spin" /> confirming on Arc…
          </p>
        )}
        <button
          type="button"
          onClick={() => {
            setSentTxUrl(null);
            setPhase("form");
          }}
          className="settle-action"
        >
          done ›
        </button>
      </div>
    );
  }

  // A send from a wallet whose export password is set must NOT silently fall back to
  // the server-signed path — the panel now tells the user their sends are signed by
  // them, and a fallback would make that claim false in exactly the case the user
  // cares about. So while the key is missing, sending waits for the password. A user
  // who does not want to enter it can still send from any other client; what they
  // cannot do is have Splitsy quietly sign on their behalf after they opted out.
  const needsOwnerKey = Boolean(exportStatus && !ownerKey);

  return (
    <div>
      <div className="iou-rail">
        <span>send to</span>
        <span>{balance ?? "…"} left</span>
      </div>
      <div className="wallet-line" data-mono>
        <input
          value={to}
          onChange={(e) => setTo(e.target.value)}
          aria-label="Recipient address"
          placeholder="0x…"
        />
      </div>
      <div className="wallet-line" data-figure>
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          aria-label="Amount in USDC"
          placeholder="0.00"
        />
        <Unit />
      </div>
      {/* The one-time prompt that buys user-signed sends. Shown only when this
          wallet has export enabled and the key is not already held for the session
          — so it appears once, not per send. */}
      {exportStatus && !ownerKey ? (
        <>
          <p className="wallet-note">
            This wallet has an export password, so you can sign this send yourself instead of
            asking Splitsy to. Enter it once — it stays for this tab only.
          </p>
          <div className="wallet-line">
            <input
              value={ownerPassword}
              onChange={(e) => setOwnerPassword(e.target.value)}
              type="password"
              autoComplete="off"
              aria-label="Export password"
              placeholder="export password"
              onKeyDown={(e) => e.key === "Enter" && ownerPassword && !phase.startsWith("sending") && deriveOwnerKey()}
            />
          </div>
          <button
            type="button"
            onClick={deriveOwnerKey}
            disabled={!ownerPassword}
            className="settle-action"
          >
            sign my sends ›
          </button>
        </>
      ) : null}
      <button type="button" onClick={send} disabled={phase === "sending" || !to || !amount || needsOwnerKey} className="settle-action">
        {phase === "sending" ? "…" : ownerKey ? "sign & send" : "send"} ›
      </button>
      {message ? (
        <p className="wallet-note" data-tone="warn" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}

type WalletTx = { id: string; direction: "in" | "out"; amount: string; address: string; state: string; txHash: string | null; date: string };

function HistoryTab() {
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

  if (txs === null) return <p className="wallet-note">Reading the chain…</p>;
  if (txs.length === 0) return <p className="wallet-note">No transactions yet.</p>;

  return (
    <div className="wallet-rows">
      {txs.map((t) => {
        const inbound = t.direction === "in";
        const other = t.address ? `${t.address.slice(0, 6)}…${t.address.slice(-4)}` : "—";
        // A row that is also a link out is an <a class="lp-row">; one with no hash
        // to point at yet is the same row without the link, so the list keeps its
        // rhythm while a transaction confirms.
        const body = (
          <>
            <span>
              <span className="wallet-dir" data-in={inbound ? "" : undefined}>
                {inbound ? "received" : "sent"}
              </span>
              <span className="lp-row-body">
                {" "}
                {inbound ? "from" : "to"} {other}
                {t.date ? ` · ${new Date(t.date).toLocaleDateString()}` : ""}
              </span>
            </span>
            <span className="wallet-amount">
              <span className="wallet-dir" data-in={inbound ? "" : undefined}>
                {inbound ? "+" : "−"}
                {t.amount}
              </span>
              {t.txHash ? <ArrowUpRight className="lp-row-out" size={12} /> : null}
            </span>
          </>
        );
        return t.txHash ? (
          <a
            key={t.id}
            href={`${explorer}/tx/${t.txHash}`}
            target="_blank"
            rel="noreferrer"
            className="lp-row"
            aria-label={`${inbound ? "Received" : "Sent"} ${t.amount} USDC — view on explorer`}
          >
            {body}
          </a>
        ) : (
          <div key={t.id} className="lp-row">
            {body}
          </div>
        );
      })}
    </div>
  );
}
