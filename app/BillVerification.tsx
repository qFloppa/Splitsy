"use client";

import { AlertTriangle, CalendarClock, CheckCircle2, ChevronDown, Info, Loader2, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import {
  BILL_SPLIT_REGISTRY_ADDRESS,
  hashReceiptBytes,
  verifyBillPreimage,
  type BillPreimage,
} from "@/lib/bill-split-contracts";

// Cache the debtor's re-OCR result keyed by the receipt's content hash, so a
// page reload doesn't re-run the (paid, slow) OCR. Content-addressed: a cache
// hit is provably the same image. localStorage may be unavailable (private mode)
// — treat any failure as a cache miss.
const OCR_CACHE_PREFIX = "splitsy-receipt-scan:";
function readCachedScan(receiptHash: string): number | null {
  try {
    const raw = window.localStorage.getItem(OCR_CACHE_PREFIX + receiptHash.toLowerCase());
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
function writeCachedScan(receiptHash: string, scannedUsd: number): void {
  try {
    window.localStorage.setItem(OCR_CACHE_PREFIX + receiptHash.toLowerCase(), String(scannedUsd));
  } catch {
    // Full/unavailable storage — just skip caching.
  }
}

// Debtor-side audit: independently OCR a receipt's bytes and return its total in
// USD, so it can be compared to the on-chain total. Returns null when OCR or FX
// is unavailable (the caller then falls back to the human eyeball check). Reuses
// the same /api/ocr and /api/fx endpoints the creator used, so the extraction
// logic is identical — only the trust source differs (the debtor runs it).
async function scanReceiptTotalUsd(bytes: Uint8Array): Promise<number | null> {
  try {
    const form = new FormData();
    form.append("image", new Blob([bytes as BlobPart], { type: "image/jpeg" }), "receipt.jpg");
    const ocr = await fetch("/api/scout/scan", { method: "POST", body: form });
    if (!ocr.ok) return null;
    const scan = (await ocr.json()) as {
      bill?: { total?: number; currency?: string };
      fx?: { amountUsd?: number };
    };
    const bill = scan.bill;
    const total = Number(bill?.total);
    if (!Number.isFinite(total) || total <= 0) return null;

    const currency = (bill?.currency ?? "USD").toUpperCase();
    if (currency === "USD") return Number(total.toFixed(2));

    // Scout buys FX during the scan; only ask again if it couldn't.
    if (Number.isFinite(scan.fx?.amountUsd)) return Number(scan.fx!.amountUsd);

    const fx = await fetch("/api/scout/fx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: total, fromCurrency: currency }),
    });
    if (!fx.ok) return null;
    const quote = (await fx.json()) as { amountUsd?: number };
    return Number.isFinite(quote.amountUsd) ? Number(quote.amountUsd) : null;
  } catch {
    return null;
  }
}

// Independent re-OCR of the receipt vs the on-chain total. "altered" is the
// signal that the creator charged something other than what the receipt reads.
// "no-receipt" = the creator typed the total by hand (nothing to cross-check).
export type AuditState =
  | { state: "idle" | "checking" | "unavailable" | "no-receipt" }
  | { state: "ok" | "altered"; scannedUsd: number; onchainUsd: number };

export type VerificationResult = {
  status: "loading" | "verified" | "mismatch" | "unpublished" | "error";
  merchant: string;
  receiptUrl: string | null;
  // The committed due date (Unix seconds), surfaced so payers know the deadline
  // their timeliness is scored against. 0/undefined = no due date on this bill.
  dueDate: number | undefined;
  audit: AuditState;
};

// Recomputes an on-chain bill's hash from its published plaintext details and
// reports whether they match the fingerprint locked on Arc. "verified" means the
// merchant/total/split are exactly what the creator committed on-chain;
// "mismatch" means they don't — a red flag. The comparison runs in the payer's
// own browser, so it trusts only the chain.
//
// Split from the panel below because the Settle deck renders the same facts in a
// different shape and must not duplicate the fetch or the audit rules.
export function useBillVerification(billId: bigint, metadataHash: `0x${string}`): VerificationResult {
  const [status, setStatus] = useState<VerificationResult["status"]>("loading");
  const [merchant, setMerchant] = useState<string>("");
  const [receiptUrl, setReceiptUrl] = useState<string | null>(null);
  const [dueDate, setDueDate] = useState<number | undefined>(undefined);
  const [audit, setAudit] = useState<AuditState>({ state: "idle" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setStatus("loading");
      setAudit({ state: "idle" });
      try {
        const res = await fetch(
          `/api/onchain-bills/preimage?registry=${BILL_SPLIT_REGISTRY_ADDRESS}&billId=${billId.toString()}`,
        );
        if (res.status === 404) {
          if (!cancelled) setStatus("unpublished");
          return;
        }
        if (!res.ok) {
          if (!cancelled) setStatus("error");
          return;
        }
        const { preimage } = (await res.json()) as { preimage: BillPreimage & { receiptUrl: string | null } };
        const ok = verifyBillPreimage(preimage, metadataHash);
        if (!cancelled) {
          setMerchant(preimage.merchant);
          // Only trust the due date once the preimage verifies — it's part of
          // the committed hash, so a verified preimage proves the creator set it.
          setDueDate(ok ? preimage.dueDate : undefined);
          setStatus(ok ? "verified" : "mismatch");
        }
        if (!ok) return;
        if (!preimage.receiptHash || !preimage.receiptUrl) {
          // Hand-entered bill: the creator typed the total, no receipt exists.
          if (!cancelled) setAudit({ state: "no-receipt" });
          return;
        }

        const onchainUsd = preimage.total;
        // Cached from a previous view? The receiptHash is content-addressed, so a
        // hit is provably the same image — no need to re-fetch or re-OCR.
        const cached = readCachedScan(preimage.receiptHash);
        if (cached !== null) {
          if (!cancelled) {
            setReceiptUrl(preimage.receiptUrl);
            const altered = Math.abs(cached - onchainUsd) > Math.max(0.05, onchainUsd * 0.02);
            setAudit({ state: altered ? "altered" : "ok", scannedUsd: cached, onchainUsd });
          }
          return;
        }

        // Fetch the committed receipt and hash it in THIS browser against the
        // committed receiptHash — trust the chain, not the storage bucket. A
        // tampered image simply won't show and won't be audited.
        let bytes: Uint8Array;
        try {
          const img = await fetch(preimage.receiptUrl);
          bytes = new Uint8Array(await img.arrayBuffer());
        } catch {
          if (!cancelled) setAudit({ state: "unavailable" });
          return;
        }
        if (hashReceiptBytes(bytes).toLowerCase() !== preimage.receiptHash.toLowerCase()) {
          // Image doesn't match the chain — don't show it or trust its total.
          if (!cancelled) setAudit({ state: "unavailable" });
          return;
        }
        if (!cancelled) {
          setReceiptUrl(preimage.receiptUrl);
          setAudit({ state: "checking" });
        }

        // Re-OCR the verified receipt and compare its total to the on-chain
        // total. Because the debtor extracts the number independently, a creator
        // who committed a different total is caught. Best-effort: if OCR/FX is
        // unavailable we fall back to the human eyeball (image is shown anyway).
        const scannedUsd = await scanReceiptTotalUsd(bytes);
        if (cancelled) return;
        if (scannedUsd === null) {
          setAudit({ state: "unavailable" });
          return;
        }
        writeCachedScan(preimage.receiptHash, scannedUsd);
        // Tolerance absorbs OCR rounding + FX drift; flag only a real gap.
        const altered = Math.abs(scannedUsd - onchainUsd) > Math.max(0.05, onchainUsd * 0.02);
        setAudit({ state: altered ? "altered" : "ok", scannedUsd, onchainUsd });
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [billId, metadataHash]);

  return { status, merchant, receiptUrl, dueDate, audit };
}

// The inline verification panel, as the Bills tab and History render it.
export default function BillVerification({
  billId,
  metadataHash,
}: {
  billId: bigint;
  metadataHash: `0x${string}`;
}) {
  const { status, merchant, receiptUrl, dueDate, audit } = useBillVerification(billId, metadataHash);
  const [showDetail, setShowDetail] = useState(false);
  // null = follow the audit (altered ⇒ open); an explicit tap overrides it.
  const [showReceipt, setShowReceipt] = useState<boolean | null>(null);

  if (status === "loading") {
    return (
      <p className="mt-2 flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
        <Loader2 className="animate-spin" size={13} /> Checking this bill against Arc…
      </p>
    );
  }

  if (status === "unpublished" || status === "error") {
    return (
      <p className="mt-2 text-xs text-[var(--text-muted)]">
        {status === "unpublished"
          ? "On-chain verification isn’t available for this bill."
          : "Couldn’t reach the verifier — refresh to retry."}
      </p>
    );
  }

  const verified = status === "verified";
  const altered = verified && audit.state === "altered";
  // Green reassurance is only honest when the commitment matches AND the receipt
  // total agrees. An altered total is treated as a red warning, like a mismatch.
  const safe = verified && !altered;
  // Altered total: the receipt IS the evidence, so open it by default — but leave
  // the user free to hide it via the toggle.
  const receiptOpen = showReceipt ?? altered;
  const title = altered
    ? `Warning — the total was changed${merchant ? ` — ${merchant}` : ""}`
    : verified
      ? `Verified on Arc${merchant ? ` — ${merchant}` : ""}`
      : "This bill doesn’t match Arc";
  return (
    <div
      className={`mt-2 rounded-[var(--radius)] border p-2.5 text-xs ${
        safe
          ? "border-[color-mix(in_srgb,var(--accent)_40%,transparent)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]"
          : "border-[color-mix(in_srgb,#dc2626_45%,transparent)] bg-[color-mix(in_srgb,#dc2626_10%,transparent)]"
      }`}
    >
      <div className="flex items-start gap-1.5 font-semibold">
        {safe ? (
          <ShieldCheck className="mt-0.5 shrink-0 text-[var(--accent)]" size={15} />
        ) : (
          <AlertTriangle className="mt-0.5 shrink-0 text-[#dc2626]" size={15} />
        )}
        <span>{title}</span>
      </div>

      {/* Two independent checks, shown separately so it's clear what passed and
          what didn't: (1) do the details match the chain, (2) does the charged
          total match the receipt. */}
      <div className="mt-2 space-y-1.5">
        {/* Check 1 — commitment integrity. */}
        {verified ? (
          <p className="flex items-start gap-1.5 text-[var(--accent)]">
            <CheckCircle2 className="mt-0.5 shrink-0" size={13} />
            <span className="text-[var(--text)]">Genuine bill on Arc — the details shown here are exactly what the creator committed (not tampered with since).</span>
          </p>
        ) : (
          <p className="flex items-start gap-1.5 font-semibold text-[#dc2626]">
            <AlertTriangle className="mt-0.5 shrink-0" size={13} />
            <span>Details don’t match Arc — don’t pay until the creator re-checks this bill.</span>
          </p>
        )}

        {/* Committed pay-by date, if the creator set one. Positive framing:
            paying on time builds reputation; it's a nudge, not a threat. */}
        {verified && dueDate ? (
          <p className="flex items-start gap-1.5 text-[var(--text-muted)]">
            <CalendarClock className="mt-0.5 shrink-0" size={13} />
            <span>
              Pay by {new Date(dueDate * 1000).toLocaleDateString()} to keep your on-chain payment reputation strong.
            </span>
          </p>
        ) : null}

        {/* Check 2 — does the charged total match the receipt? Only meaningful
            once the commitment itself is verified. */}
        {verified && audit.state === "checking" ? (
          <p className="flex items-center gap-1.5 text-[var(--text-muted)]">
            <Loader2 className="animate-spin" size={13} /> Checking the total against the receipt…
          </p>
        ) : null}
        {verified && audit.state === "ok" ? (
          <p className="flex items-start gap-1.5 text-[var(--accent)]">
            <CheckCircle2 className="mt-0.5 shrink-0" size={13} />
            <span className="text-[var(--text)]">Total matches the receipt (~${audit.onchainUsd.toFixed(2)}).</span>
          </p>
        ) : null}
        {verified && audit.state === "altered" ? (
          <p className="flex items-start gap-1.5 font-semibold text-[#dc2626]">
            <AlertTriangle className="mt-0.5 shrink-0" size={13} />
            <span>
              Total was changed — the receipt reads about ${audit.scannedUsd.toFixed(2)}, but you’re charged $
              {audit.onchainUsd.toFixed(2)}. Ask the creator before paying.
            </span>
          </p>
        ) : null}
        {verified && audit.state === "no-receipt" ? (
          <p className="flex items-start gap-1.5 text-[var(--text-muted)]">
            <Info className="mt-0.5 shrink-0" size={13} />
            <span>No receipt was uploaded — the creator typed this total by hand, so it can’t be checked against a bill.</span>
          </p>
        ) : null}
        {verified && audit.state === "unavailable" ? (
          <p className="flex items-start gap-1.5 text-[var(--text-muted)]">
            <Info className="mt-0.5 shrink-0" size={13} />
            <span>Couldn’t re-read the total automatically — open the receipt below and compare it yourself.</span>
          </p>
        ) : null}
      </div>

      {verified && receiptUrl ? (
        <div className="mt-2">
          <button
            className="inline-flex items-center gap-1 text-[var(--text-muted)] underline underline-offset-2"
            onClick={() => setShowReceipt(!receiptOpen)}
            type="button"
          >
            <ChevronDown className={`transition-transform ${receiptOpen ? "rotate-180" : ""}`} size={12} />
            {receiptOpen ? "Hide receipt" : "View the receipt committed on-chain"}
          </button>
          {receiptOpen ? (
            <div className="mt-1.5">
              <p className="mb-1 text-[var(--text-muted)]">Check the total matches what you’re charged:</p>
              <a href={receiptUrl} rel="noreferrer" target="_blank">
                {/* Plain img: a Supabase Storage URL isn't in next.config's allowed domains. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  alt="Receipt committed on-chain for this bill"
                  className="max-h-64 w-auto rounded-[var(--radius)] border border-[var(--receipt-border-soft)]"
                  src={receiptUrl}
                />
              </a>
            </div>
          ) : null}
        </div>
      ) : null}

      <button
        className="mt-2 inline-flex items-center gap-1 text-[var(--text-muted)] underline underline-offset-2"
        onClick={() => setShowDetail((open) => !open)}
        type="button"
      >
        <ChevronDown className={`transition-transform ${showDetail ? "rotate-180" : ""}`} size={12} />
        What does this mean?
      </button>
      {showDetail ? (
        <div className="mt-1.5 space-y-2 text-[var(--text-muted)]">
          <p>
            <span className="font-semibold text-[var(--text)]">1. Genuine bill on Arc.</span> When this bill
            was created, Splitsy wrote a tamper-proof fingerprint of its details onto the Arc blockchain,
            where it can’t be edited. Your browser recomputed that fingerprint and
            {verified
              ? " it matches — so the merchant, total, and split shown here are exactly what the creator committed. (This does NOT mean the total is correct — that’s check 2.)"
              : " it does NOT match — so what you’re shown is not what was committed. Don’t pay."}
          </p>
          <p>
            <span className="font-semibold text-[var(--text)]">2. Total matches the receipt.</span>{" "}
            {audit.state === "no-receipt"
              ? "This bill has no receipt — the creator entered the total by hand, so there’s nothing to cross-check the amount against."
              : audit.state === "ok"
                ? "The receipt image is committed too, so your browser re-read it and confirmed its total matches what you’re being charged."
                : audit.state === "altered"
                  ? "Your browser re-read the committed receipt: the total the creator committed doesn’t match the amount printed on the receipt. The bill is genuine, but the charged total is wrong."
                  : "The receipt image is committed, but your browser couldn’t re-read its total automatically — open it above and compare by eye."}
          </p>
          <p className="break-all font-mono text-[10px]">On-chain hash: {metadataHash}</p>
        </div>
      ) : null}
    </div>
  );
}
