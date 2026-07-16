"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";
import { Mail, WalletCards } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";

import { DiscordIcon, XIcon } from "./ProviderIcons";

const PROVIDERS = [
  { key: "x", label: "@splitsy_xyz", kind: "X handle", icon: <XIcon size={16} /> },
  { key: "discord", label: "Splitsy", kind: "Discord username", icon: <DiscordIcon size={16} /> },
  { key: "email", label: "info@splitsy.xyz", kind: "Email address", icon: <Mail size={16} /> },
  { key: "wallet", label: "0xEE42…70AC", kind: "Wallet address", icon: <WalletCards size={16} /> },
];

// "Anyone" made concrete: the same four identities the demo just used, as
// live chips. No feature grid, no copy blocks — one sentence and the proof.
export function SectionAnyone() {
  const rootRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const root = rootRef.current;
    if (!root) return;

    const ctx = gsap.context(() => {
      gsap.from("[data-anyone-heading]", {
        y: 26,
        autoAlpha: 0,
        duration: 0.8,
        ease: "expo.out",
        scrollTrigger: { trigger: root, start: "top 74%" },
      });
      gsap.from("[data-anyone-chip]", {
        y: 22,
        autoAlpha: 0,
        duration: 0.65,
        ease: "expo.out",
        stagger: 0.07,
        scrollTrigger: { trigger: root, start: "top 66%" },
      });
    }, root);

    return () => ctx.revert();
  }, []);

  return (
    <section
      aria-labelledby="anyone-heading"
      className="mx-auto w-full max-w-[80rem] px-4 py-[var(--lp-section-y)] sm:px-6 lg:px-8"
      ref={rootRef}
    >
      <h2 className="lp-display-lg max-w-3xl" data-anyone-heading id="anyone-heading">
        No wallet? <span className="lp-headline-accent">No problem.</span>
      </h2>
      <p className="lp-lede mt-5 max-w-xl" data-anyone-heading>
        Tag people where they already are. Splitsy holds their share in escrow on Arc until they claim it
        with a handle, an inbox, or an address.
      </p>

      <ul className="mt-12 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 lg:grid-cols-4">
        {PROVIDERS.map((provider) => (
          <li data-anyone-chip key={provider.key}>
            <motion.div
              className="flex items-center gap-3.5 rounded-[calc(var(--radius)+4px)] border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow-soft)] backdrop-blur-xl"
              transition={{ type: "spring", stiffness: 320, damping: 22 }}
              whileHover={reduced ? undefined : { y: -4, scale: 1.015 }}
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface-strong)] text-[var(--text-soft)]">
                {provider.icon}
              </span>
              <span className="min-w-0">
                <span className={`block truncate text-sm font-bold text-[var(--text)] ${provider.key === "wallet" ? "mono" : ""}`}>
                  {provider.label}
                </span>
                <span className="block text-xs font-medium text-[var(--text-muted)]">{provider.kind}</span>
              </span>
            </motion.div>
          </li>
        ))}
      </ul>
    </section>
  );
}
