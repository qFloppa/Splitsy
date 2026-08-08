"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import {
  ListChecks, Star, GitMerge, Bell, ShieldCheck, Camera, ArrowLeftRight,
} from "lucide-react";

gsap.registerPlugin(ScrollTrigger);

// Plain-English capability cards — one per paywalled endpoint.
// Shown above the technical SectionApiDocs explorer so non-developer
// visitors can understand what's possible before reading the code.
const CAPABILITIES = [
  {
    Icon: ListChecks,
    title: "Settle bills hands-free",
    description:
      "Connect a Circle Agent Wallet and your bills pay themselves. The agent " +
      "checks what you owe, reviews for fraud, and settles in USDC while you sleep.",
    tag: "Autopay",
  },
  {
    Icon: Star,
    title: "Check anyone's reputation",
    description:
      "Before splitting or lending, look up any wallet or social handle's Splitsy " +
      "score — one number that shows how reliably they pay.",
    tag: "Trust",
  },
  {
    Icon: GitMerge,
    title: "Minimize group transfers",
    description:
      "Going on a trip with friends? The netting engine calculates the fewest USDC " +
      "transfers to square everyone — no tangled back-and-forth chains.",
    tag: "Netting",
  },
  {
    Icon: Bell,
    title: "Automate payment reminders",
    description:
      "Build a creditor bot using the same dunning logic Splitsy runs daily — it " +
      "tells you when to nudge, when to escalate, and when to auto-collect.",
    tag: "Dunning",
  },
  {
    Icon: ShieldCheck,
    title: "Verify a bill before paying",
    description:
      "An LLM auditor checks if a bill's details are plausible given the merchant, " +
      "share size, and creator's track record — approve or refuse in one call.",
    tag: "Fraud check",
  },
  {
    Icon: Camera,
    title: "Scan any receipt instantly",
    description:
      "Send a receipt photo and get back structured data — merchant, currency, " +
      "total, line items — ready to create and split a bill in seconds.",
    tag: "OCR",
  },
  {
    Icon: ArrowLeftRight,
    title: "Split bills in any currency",
    description:
      "Paid in euros abroad? Convert any foreign amount to USDC automatically so " +
      "everyone's share is exact, no matter the currency.",
    tag: "FX",
  },
];

export function SectionApiUseCases() {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const root = rootRef.current;
    if (!root) return;
    const ctx = gsap.context(() => {
      gsap.from("[data-apiuc-heading]", {
        y: 26, autoAlpha: 0, duration: 0.8, ease: "expo.out",
        scrollTrigger: { trigger: root, start: "top 78%" },
      });
      gsap.from("[data-apiuc-card]", {
        y: 20, autoAlpha: 0, duration: 0.55, ease: "expo.out", stagger: 0.06,
        scrollTrigger: { trigger: root, start: "top 64%" },
      });
    }, root);
    return () => ctx.revert();
  }, []);

  return (
    <section
      ref={rootRef}
      aria-labelledby="apiuc-heading"
      className="mx-auto w-full max-w-[88rem] px-4 pt-[var(--lp-section-y)] sm:px-6 lg:px-8"
    >
      <p
        data-apiuc-heading
        className="text-[0.62rem] font-extrabold uppercase tracking-[0.14em] text-[var(--text-muted)]"
      >
        What you can build
      </p>
      <h2
        data-apiuc-heading
        id="apiuc-heading"
        className="lp-display-lg mt-3 max-w-3xl"
      >
        Seven APIs.{" "}
        <span className="lp-headline-accent">Endless possibilities.</span>
      </h2>
      <p data-apiuc-heading className="lp-lede mt-5 max-w-2xl">
        No account. No API key. No gas. Pay per call in USDC and unlock bill
        automation, reputation data, group settlement math, and more — open to
        any agent or app, right now.
      </p>

      <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {CAPABILITIES.map(({ Icon, title, description, tag }) => (
          <div
            key={title}
            data-apiuc-card
            className="flex flex-col gap-3 rounded-[calc(var(--radius)+4px)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-soft)] backdrop-blur-xl"
          >
            <div className="flex items-center justify-between">
              <span
                className="flex size-9 items-center justify-center rounded-[var(--radius)]"
                style={{ background: "var(--accent-soft)" }}
              >
                <Icon size={17} style={{ color: "var(--accent)" }} />
              </span>
              <span
                className="mono rounded-full px-2 py-0.5 text-[0.62rem] font-bold uppercase tracking-[0.08em]"
                style={{
                  background: "var(--surface-strong)",
                  color: "var(--text-muted)",
                }}
              >
                {tag}
              </span>
            </div>
            <p className="text-sm font-bold leading-snug text-[var(--text)]">
              {title}
            </p>
            <p className="text-xs leading-relaxed text-[var(--text-soft)]">
              {description}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
