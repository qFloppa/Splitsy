"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { PRICES } from "@/lib/x402/pricing";

const NEW_ENDPOINTS = [
  { path: "/api/agents/queue",           price: PRICES["/api/agents/queue"],           method: "GET"  },
  { path: "/api/reputation",             price: PRICES["/api/reputation"],             method: "GET"  },
  { path: "/api/agents/netting",         price: PRICES["/api/agents/netting"],         method: "POST" },
  { path: "/api/agents/dunning/verdict", price: PRICES["/api/agents/dunning/verdict"], method: "POST" },
] as const;

export function SectionDevTeaser() {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const root = rootRef.current;
    if (!root) return;
    const ctx = gsap.context(() => {
      gsap.from("[data-devteaser-el]", {
        y: 20, autoAlpha: 0, duration: 0.7, ease: "expo.out", stagger: 0.09,
        scrollTrigger: { trigger: root, start: "top 72%" },
      });
    }, root);
    return () => ctx.revert();
  }, []);

  return (
    <section
      ref={rootRef}
      aria-label="Developer API"
      className="mx-auto w-full max-w-[80rem] scroll-mt-24 px-4 pt-[var(--lp-section-y)] sm:px-6 lg:px-8"
    >
      {/* Single accent-bordered card — spec-card-live treatment */}
      <div
        data-devteaser-el
        className="lp-glass relative overflow-hidden"
      >
        {/* Left-edge accent rail */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-[3px]"
          style={{ background: "linear-gradient(180deg, var(--accent), color-mix(in srgb, #93c5fd 65%, var(--accent)))" }}
        />

        <div className="grid grid-cols-1 gap-8 p-6 sm:p-8 lg:grid-cols-[1fr_auto]">

          {/* Left: narrative */}
          <div className="flex flex-col">
            <p
              data-devteaser-el
              className="text-[0.62rem] font-extrabold uppercase tracking-[0.08em] text-[var(--accent)]"
            >
              Open to any agent · Developer API
            </p>
            <h2
              data-devteaser-el
              className="lp-display-md mt-3"
            >
              Seven APIs.{" "}
              <span className="lp-headline-accent">Any agent.</span>
            </h2>
            <p data-devteaser-el className="lp-lede mt-4 max-w-xl">
              Every endpoint answers HTTP&nbsp;402 with a Circle Gateway
              challenge. Sign one offchain EIP-3009 authorisation — no Splitsy
              account, no API key, no gas — and you're in.
            </p>

            {/* 4-step flow — tiny pills */}
            <ol data-devteaser-el className="mono mt-5 flex list-none flex-wrap gap-2 p-0 text-[0.7rem]">
              {["01 Probe", "02 Parse", "03 Sign", "04 Retry"].map((step) => (
                <li
                  key={step}
                  className="rounded-full border border-[var(--border)] bg-[var(--surface-strong)] px-2.5 py-1 font-bold text-[var(--text-muted)]"
                >
                  {step}
                </li>
              ))}
            </ol>

            <div data-devteaser-el className="mt-6">
              <Link
                href="/api"
                className="group primary-button inline-flex items-center gap-2"
              >
                Explore developer docs
                <ArrowRight
                  size={15}
                  className="transition-transform duration-[var(--dur-2)] group-hover:translate-x-0.5"
                />
              </Link>
            </div>
          </div>

          {/* Right: endpoint grid */}
          <ul
            data-devteaser-el
            className="flex list-none flex-col gap-2 p-0 lg:w-72 lg:shrink-0"
          >
            {NEW_ENDPOINTS.map((ep) => (
              <li
                key={ep.path}
                className="flex items-baseline justify-between gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-strong)] px-3 py-2"
              >
                <span className="mono min-w-0 truncate text-xs font-bold text-[var(--text)]">
                  {ep.path}
                </span>
                <span className="mono shrink-0 text-xs font-bold text-[var(--accent)]">
                  {ep.price}
                </span>
              </li>
            ))}
            <li className="mt-1 text-right text-[0.7rem] text-[var(--text-muted)]">
              + 3 existing endpoints
            </li>
          </ul>

        </div>
      </div>
    </section>
  );
}
