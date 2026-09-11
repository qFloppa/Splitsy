"use client";

import { Check, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

// The browser half of wallet key export. EVERY SECRET IN THIS FILE STAYS IN THIS
// FILE: the password, the P-256 key derived from it, the ephemeral HPKE private
// key, and the exported wallet key. Nothing is sent to Splitsy, nothing is written
// to localStorage or sessionStorage, and nothing is logged.
//
// lib/export-crypto is imported DYNAMICALLY so @hpke/* and @noble/* — around 30KB
// the rest of the app has no use for — stay out of the main bundle and load only
// when someone opens this tab.
//
// Design: docs/superpowers/specs/2026-09-08-privy-key-export-design.md
type Status = {
  state: "not_enabled" | "enabled" | "needs_restore";
  walletId: string;
  appId: string;
  address: string;
  exportOwnerKey: string | null;
};

export default function ExportTab({ address }: { address: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [locked, setLocked] = useState(false);
  const [pin, setPin] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);

  async function load() {
    const res = await fetch("/api/wallet/export");
    const data = await res.json();
    if (res.status === 403) return setLocked(true);
    if (!res.ok) return setLoadError(data.error ?? "Could not load export.");
    setLocked(false);
    setStatus(data as Status);
  }

  useEffect(() => {
    // The rule reads `load` as a synchronous setState because it calls one
    // somewhere; every one of them is behind the `await fetch` on its first line,
    // so nothing is set during this render. Same reason XAuthControl.tsx:180 has.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load().catch(() => setLoadError("Network error — please try again."));
  }, []);

  // Same inline unlock SendTab does (app/XAuthControl.tsx:583-594) — export is
  // gated on the same 5-minute cookie, so sending the user to another tab to get
  // it would be a detour the panel does not make anywhere else.
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
    await load();
  }

  // Everything below runs in ONE function so the derived key never becomes
  // component state. It lives for the length of this call and is dropped when it
  // returns.
  async function runExport(current: Status, pwd: string, reveal: boolean) {
    const crypto = await import("@/lib/export-crypto");
    const secretKey = await crypto.deriveOwnerSecretKey(pwd, current.address);
    const publicKey = await crypto.ownerPublicKeySpki(secretKey);

    // The local pre-check. A wrong password fails HERE, with no request made and
    // no 401 to interpret — possible only because the PUBLIC half of the
    // credential is recorded server-side.
    if (current.exportOwnerKey && current.exportOwnerKey !== publicKey) {
      throw new Error("That password doesn't match this wallet's export credential.");
    }

    const recipient = await crypto.createExportRecipient();
    const signature = crypto.signAuthorization(
      crypto.canonicalPayload(
        crypto.exportRequestInput(current.walletId, current.appId, recipient.publicKeySpkiBase64),
      ),
      secretKey,
    );

    const res = await fetch("/api/wallet/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipientPublicKey: recipient.publicKeySpkiBase64, signature }),
    });
    const data = await res.json();
    if (res.status === 403) {
      setLocked(true);
      throw new Error("Wallet locked — enter your PIN.");
    }
    if (!res.ok) throw new Error(data.error ?? "Splitsy could not authorise this export.");

    let plaintext: string;
    try {
      plaintext = await recipient.open(data.encapsulated_key, data.ciphertext);
    } catch {
      // Distinguished from a 401 on purpose: a suite or ephemeral-key fault, not a
      // credential fault. Telling the user to check their password would send them
      // down the wrong path.
      throw new Error("Could not decrypt the exported key. Please try again.");
    }

    // THE GUARD. A key we cannot prove belongs to this wallet is not shown, not
    // copied, not logged — not even quoted back in the error.
    if (!crypto.verifyExportedKey(plaintext, current.address)) {
      throw new Error("The exported key did not match this wallet. Nothing was revealed.");
    }
    return reveal ? plaintext : null;
  }

  async function enable() {
    if (!status) return;
    const restoring = status.state === "needs_restore";
    setMessage(null);
    // BEFORE the dynamic import, not after the validation: that import fetches the
    // crypto chunk over the network on first use, and the button is disabled on
    // `busy` alone — a double-click inside that window would issue two PUTs.
    // The validation moves inside the try so the `finally` below always clears it.
    setBusy(true);
    // Which side of the PUT a failure landed on. After the PUT the password is
    // recorded and cannot be enabled again, so the same thrown message means two
    // very different things and must not be reported the same way.
    let recorded = false;
    try {
      const crypto = await import("@/lib/export-crypto");
      if (password.length < crypto.MIN_PASSWORD_LENGTH) {
        return setMessage(`Use at least ${crypto.MIN_PASSWORD_LENGTH} characters.`);
      }
      if (password !== confirm) return setMessage("The passwords don't match — try again.");

      const secretKey = await crypto.deriveOwnerSecretKey(password, status.address);
      const publicKey = await crypto.ownerPublicKeySpki(secretKey);

      // RESTORE PROVES BEFORE IT RECORDS; ENABLE TRANSFERS BEFORE IT PROVES. The
      // orders are opposite because the risks are. On the enable path the PUT is
      // what moves ownership, so it has to come first. On the restore path the PUT
      // moves nothing — it only writes the cache — and writing it first is what
      // used to strand people: a mistyped password, or a wallet whose ownership
      // never moved at all, recorded a key that made resolveState answer "enabled"
      // forever while the 409 blocked every retry. Proving first means a failed
      // restore writes NOTHING and the user can simply try again.
      if (restoring) {
        await runExport(status, password, false);
      }

      const res = await fetch("/api/wallet/export", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicKey }),
      });
      const data = await res.json();
      // The same 403 runExport handles, and for the same reason: the unlock cookie
      // is 5 minutes and this screen is four paragraphs of custody copy plus a
      // password typed twice. Without this the user reads the bare word "locked"
      // with no PIN field in sight.
      if (res.status === 403) {
        setLocked(true);
        throw new Error("Wallet locked — enter your PIN.");
      }
      if (!res.ok) throw new Error(data.error ?? "Could not enable export.");
      recorded = true;

      const next: Status = { ...status, state: "enabled", exportOwnerKey: publicKey };
      setStatus(next);

      // ENABLING ENDS WITH A PROOF, NOT A KEY. A real export runs, the plaintext is
      // checked against the address and then dropped. It closes the worst hole in a
      // typed credential: a password mistyped identically in both fields transfers
      // ownership to a key nobody can reproduce, and the wallet is non-exportable
      // forever with no signal. Revealing is a separate, deliberate click.
      //
      // Skipped when restoring — the proof already ran above, and running it twice
      // is a second export round-trip for an answer we have.
      if (!restoring) await runExport(next, password, false);
      setVerified(true);
      setPassword("");
      setConfirm("");
      setMessage(null);
    } catch (err) {
      const detail = err instanceof Error ? err.message : "Could not enable export.";
      // Three outcomes, three readings. A restore that failed its proof recorded
      // NOTHING, so say that plainly and name the other reason it can fail: a
      // wallet minted before export existed is owned by a quorum no password
      // reproduces, and no password will ever restore it.
      setMessage(
        recorded
          ? `Your password was recorded, but we could not verify that it exports this wallet: ${detail} Do not rely on it until a reveal succeeds.`
          : restoring
            ? `${detail} Nothing was recorded, so you can try again. If this wallet was created before export was available, no password can restore it.`
            : detail,
      );
    } finally {
      setBusy(false);
    }
  }

  async function reveal() {
    if (!status) return;
    setMessage(null);
    setBusy(true);
    try {
      setRevealed(await runExport(status, password, true));
      setPassword("");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setBusy(false);
    }
  }

  const warn = message ? (
    <p className="wallet-note" data-tone="warn" role="status">
      {message}
    </p>
  ) : null;

  if (locked) {
    return (
      <div>
        <p className="settle-label">unlock to export</p>
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
        {warn}
      </div>
    );
  }

  if (loadError) {
    return (
      <p className="wallet-note" data-tone="warn" role="status">
        {loadError}
      </p>
    );
  }

  if (!status) {
    return (
      <p className="wallet-note">
        <Loader2 size={11} className="animate-spin" /> loading…
      </p>
    );
  }

  if (revealed) {
    return (
      <div>
        <p className="settle-label">your private key</p>
        <p className="wallet-proof wallet-export-key">{revealed}</p>
        <p className="wallet-note">
          This is the key <b>Privy</b> has been holding for you. Splitsy never sees it. Import it into
          any Ethereum wallet to control {address} directly — and anyone who has it controls this
          wallet.
        </p>
        <button type="button" onClick={() => setRevealed(null)} className="settle-action">
          done ›
        </button>
      </div>
    );
  }

  if (status.state === "enabled") {
    return (
      <div>
        {verified ? (
          <p className="wallet-note" data-tone="ok" role="status">
            <Check size={11} /> verified — this password exports this wallet. <b>Privy</b> will only
            ever release this key to it.
          </p>
        ) : null}
        <p className="settle-label">export your key</p>
        <p className="wallet-note">
          Your assets are held by <b>Privy</b>, the custodian. Only your export password can
          authorise releasing this wallet&apos;s private key — Splitsy cannot, and cannot reset it.
        </p>
        <div className="wallet-line">
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            autoComplete="off"
            aria-label="Export password"
            placeholder="export password"
            onKeyDown={(e) => e.key === "Enter" && password && !busy && reveal()}
          />
        </div>
        <button type="button" onClick={reveal} disabled={busy || !password} className="settle-action">
          {busy ? "…" : "reveal private key"} ›
        </button>
        {warn}
      </div>
    );
  }

  const restoring = status.state === "needs_restore";
  return (
    <div>
      <p className="settle-label">{restoring ? "restore your export record" : "enable export"}</p>
      <p className="wallet-note">
        Your assets are held by <b>Privy</b>, the custodian. Splitsy is the app that operates this
        wallet on your behalf.
      </p>
      <p className="wallet-note">
        {restoring
          ? "This wallet is owned by a key Splitsy does not hold. Usually that means an export password was set here and we lost our record of it — re-enter it to restore the record. If you never set one, this wallet was created before export was available and cannot be exported; no password will change that."
          : "Until you set an export password, Splitsy can export this wallet's private key itself, and is authorised to move your assets on your behalf. Setting one ends the first of those, not the second: only your password can release this wallet's private key — with no recovery — and sends you make in the wallet panel are signed by you, so Splitsy cannot move your money at will. Splitsy keeps signing for what runs without you: autopay, and pay-link claims. Choose something you will not forget."}
      </p>
      <div className="wallet-line">
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          type="password"
          autoComplete="off"
          aria-label="Export password"
          placeholder="export password"
        />
      </div>
      <div className="wallet-line">
        <input
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          type="password"
          autoComplete="off"
          aria-label="Confirm export password"
          placeholder="confirm password"
        />
      </div>
      <button type="button" onClick={enable} disabled={busy} className="settle-action">
        {busy ? "…" : restoring ? "restore" : "enable export"} ›
      </button>
      {warn}
      <p className="wallet-note">
        Your <b>pay wallet</b> is exportable. Your <b>agent wallet</b> is not yet — if you have topped
        it up, that USDC cannot be exported today.
      </p>
      <p className="wallet-note">
        Splitsy serves this page&apos;s code, so a compromised Splitsy could capture your password as
        you type it. Setting an export password protects you against a later breach, not against us
        at the moment you use this feature.
      </p>
    </div>
  );
}
