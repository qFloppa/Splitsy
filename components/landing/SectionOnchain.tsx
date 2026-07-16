"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";
import { ArrowRight, FileCheck2, ReceiptText, ShieldCheck } from "lucide-react";

// The trust story, kept quiet: receipt bytes are hashed, the hash is committed
// in the BillCreated event, so any payer can verify the split matches the
// paper. Three stations, one line each — the connector draws itself in as
// the section enters.
export function SectionOnchain() {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const root = rootRef.current;
    if (!root) return;

    const ctx = gsap.context(() => {
      gsap.from("[data-onchain-heading]", {
        y: 26,
        autoAlpha: 0,
        duration: 0.8,
        ease: "expo.out",
        scrollTrigger: { trigger: root, start: "top 74%" },
      });
      gsap.from("[data-onchain-step]", {
        y: 24,
        autoAlpha: 0,
        duration: 0.7,
        ease: "expo.out",
        stagger: 0.14,
        scrollTrigger: { trigger: root, start: "top 62%" },
      });
      gsap.from("[data-onchain-arrow]", {
        autoAlpha: 0,
        scale: 0.6,
        duration: 0.45,
        ease: "back.out(2)",
        stagger: 0.14,
        delay: 0.18,
        scrollTrigger: { trigger: root, start: "top 62%" },
      });
    }, root);

    return () => ctx.revert();
  }, []);

  return (
    <section
      aria-labelledby="onchain-heading"
      className="mx-auto w-full max-w-[80rem] px-4 pb-[var(--lp-section-y)] sm:px-6 lg:px-8"
      ref={rootRef}
    >
      <h2 className="lp-display-lg max-w-3xl" data-onchain-heading id="onchain-heading">
        Don&apos;t trust the split. <span className="lp-headline-accent">Verify it.</span>
      </h2>
      <p className="lp-lede mt-5 max-w-xl" data-onchain-heading>
        The receipt&apos;s fingerprint is written into the bill on Arc. Anyone tagged can check that what
        they&apos;re paying matches the paper before they pay.
      </p>

      <div className="mt-12 flex flex-col items-stretch gap-3 lg:flex-row lg:items-center">
        <div
          className="flex-1 rounded-[calc(var(--radius)+4px)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-soft)] backdrop-blur-xl"
          data-onchain-step
        >
          <ReceiptText className="text-[var(--text-soft)]" size={20} />
          <p className="mt-3 text-sm font-bold text-[var(--text)]">The receipt</p>
          <p className="mt-1 text-sm text-[var(--text-muted)]">Scanned, itemized, and hashed byte for byte.</p>
          <p className="mono mt-3 truncate text-xs text-[var(--text-muted)]">keccak256(receipt.jpg)</p>
        </div>

        <ArrowRight className="mx-auto shrink-0 rotate-90 text-[var(--text-muted)] lg:rotate-0" data-onchain-arrow size={18} />

        <div
          className="flex-1 rounded-[calc(var(--radius)+4px)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-soft)] backdrop-blur-xl"
          data-onchain-step
        >
          <FileCheck2 className="text-[var(--text-soft)]" size={20} />
          <p className="mt-3 text-sm font-bold text-[var(--text)]">The bill on Arc</p>
          <p className="mt-1 text-sm text-[var(--text-muted)]">Every share and the fingerprint, committed in one event.</p>
          <p className="mono mt-3 truncate text-xs text-[var(--accent)]">BillCreated(billId, metadataHash)</p>
        </div>

        <ArrowRight className="mx-auto shrink-0 rotate-90 text-[var(--text-muted)] lg:rotate-0" data-onchain-arrow size={18} />

        <div
          className="flex-1 rounded-[calc(var(--radius)+4px)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-soft)] backdrop-blur-xl"
          data-onchain-step
        >
          <ShieldCheck className="text-[var(--success)]" size={20} />
          <p className="mt-3 text-sm font-bold text-[var(--text)]">The check</p>
          <p className="mt-1 text-sm text-[var(--text-muted)]">Payers recompute the hash and confirm it matches before paying.</p>
          <p className="mono mt-3 truncate text-xs text-[var(--success)]">✓ matches on-chain commitment</p>
        </div>
      </div>
    </section>
  );
}
