"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";
import { ArrowRight, ArrowRightLeft, Layers, Scale } from "lucide-react";

// The DeFi half of the story, deliberately three quiet stations so it supports
// the agent stage above rather than competing with it.
//
// The arithmetic is buildTreasury()'s own: grossTxCount = 2 * payLegCount +
// claimLegCount, so 5 bills you owe plus 4 you are owed is 2*5 + 4 = 14. If the
// station copy changes, that identity has to keep holding.
//
// The footnote is not hedging. lib/treasury.ts and DashboardPanel both state
// that the net figure is exposure, not a transfer, and that batching removes
// transactions rather than USDC moved. The landing page must not contradict the
// product a judge can go and read.
export function SectionTreasury() {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const root = rootRef.current;
    if (!root) return;

    const ctx = gsap.context(() => {
      gsap.from("[data-treasury-heading]", {
        y: 26,
        autoAlpha: 0,
        duration: 0.8,
        ease: "expo.out",
        scrollTrigger: { trigger: root, start: "top 74%" },
      });
      gsap.from("[data-treasury-step]", {
        y: 24,
        autoAlpha: 0,
        duration: 0.7,
        ease: "expo.out",
        stagger: 0.14,
        scrollTrigger: { trigger: root, start: "top 62%" },
      });
      gsap.from("[data-treasury-arrow]", {
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
      aria-labelledby="treasury-heading"
      className="mx-auto w-full max-w-[80rem] scroll-mt-24 px-4 pb-[var(--lp-section-y)] sm:px-6 lg:px-8"
      id="treasury"
      ref={rootRef}
    >
      <h2 className="lp-display-lg max-w-3xl" data-treasury-heading id="treasury-heading">
        Many debts. <span className="lp-headline-accent">One position.</span>
      </h2>
      <p className="lp-lede mt-5 max-w-xl" data-treasury-heading>
        Every share you owe and are owed collapses into one net figure per person. Settling fires them
        as a batch — one atomic transaction on a Circle wallet instead of an approve and a payment per
        bill.
      </p>

      <div className="mt-12 flex flex-col items-stretch gap-3 lg:flex-row lg:items-center">
        <div
          className="flex-1 rounded-[calc(var(--radius)+4px)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-soft)] backdrop-blur-xl"
          data-treasury-step
        >
          <Layers className="text-[var(--text-soft)]" size={20} />
          <p className="mt-3 text-sm font-bold text-[var(--text)]">The open ledger</p>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Shares scattered across every bill you joined or created.
          </p>
          <p className="mono mt-3 truncate text-xs text-[var(--text-muted)]">
            5 bills you owe · 4 you&apos;re owed
          </p>
        </div>

        <ArrowRight
          className="mx-auto shrink-0 rotate-90 text-[var(--text-muted)] lg:rotate-0"
          data-treasury-arrow
          size={18}
        />

        <div
          className="flex-1 rounded-[calc(var(--radius)+4px)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-soft)] backdrop-blur-xl"
          data-treasury-step
        >
          <Scale className="text-[var(--text-soft)]" size={20} />
          <p className="mt-3 text-sm font-bold text-[var(--text)]">One net position</p>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Everything owed in both directions, collapsed per counterparty.
          </p>
          <p className="mono mt-3 truncate text-xs text-[var(--accent)]">
            −12.40 Alex · +8.00 Sam · −0.60 0x9f…
          </p>
        </div>

        <ArrowRight
          className="mx-auto shrink-0 rotate-90 text-[var(--text-muted)] lg:rotate-0"
          data-treasury-arrow
          size={18}
        />

        <div
          className="flex-1 rounded-[calc(var(--radius)+4px)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-soft)] backdrop-blur-xl"
          data-treasury-step
        >
          <ArrowRightLeft className="text-[var(--success)]" size={20} />
          <p className="mt-3 text-sm font-bold text-[var(--text)]">One settlement</p>
          <p className="mt-1 text-sm text-[var(--text-muted)]">
            Every approval, payment and claim lands together, or none of it does.
          </p>
          <p className="mono mt-3 truncate text-xs text-[var(--success)]">1 atomic tx instead of 14</p>
        </div>
      </div>

      <p className="mt-6 max-w-2xl text-xs text-[var(--text-muted)]">
        Netting is a view, not a transfer. Each bill escrows its own USDC on Arc, so every debt is still
        paid to its own bill — batching removes transactions, never the money owed, and it never
        collects what someone else still owes you.
      </p>
    </section>
  );
}
