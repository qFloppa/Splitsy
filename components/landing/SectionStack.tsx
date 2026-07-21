"use client";

import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import gsap from "gsap";
import {
  ArrowLeftRight,
  ArrowUpRight,
  BadgeCheck,
  Fuel,
  Layers,
  WalletCards,
  Webhook,
  Zap,
} from "lucide-react";
import { motion, useReducedMotion } from "motion/react";

type Tech = {
  key: string;
  origin: "Arc" | "Circle" | "ERC standard";
  name: string;
  description: string;
  proof: string;
  href: string;
  linkLabel: string;
  icon: ReactNode;
  wide?: boolean;
};

// Every claim below is checked against the code and the official docs — this
// section is the "receipts" for the infrastructure, so keep it that way.
const STACK: Tech[] = [
  {
    key: "arc",
    origin: "Arc",
    name: "Arc — the settlement chain",
    description:
      "The EVM Layer 1 purpose-built for stablecoin finance. Splitsy's bill registry and recurring tabs are Solidity contracts on Arc Testnet, and every payment settles with deterministic sub-second finality — one confirmation, no reorgs.",
    proof: "chainId 5042002 · finality < 1s · Malachite BFT",
    href: "https://docs.arc.io/arc-chain",
    linkLabel: "docs.arc.io",
    icon: <Zap size={17} />,
    wide: true,
  },
  {
    key: "usdc-gas",
    origin: "Arc",
    name: "USDC-native gas",
    description:
      "USDC is Arc's native gas token, so a share and the fee to pay it live in one dollar-denominated asset. No volatile gas token to acquire, hold, or explain.",
    proof: "USDC 0x3600…0000 · fees in USDC",
    href: "https://docs.arc.io/arc/concepts/stablecoin-native-model",
    linkLabel: "docs.arc.io",
    icon: <Fuel size={17} />,
  },
  {
    key: "circle-wallets",
    origin: "Circle",
    name: "Developer-Controlled Wallets",
    description:
      "Sign in with X, Discord, Google, or email and Splitsy provisions a Circle smart-contract wallet on Arc — no seed phrase, no extension. Payments are contract executions signed through Circle's wallet API.",
    proof: 'accountType: "SCA" · ARC-TESTNET',
    href: "https://developers.circle.com/wallets/dev-controlled",
    linkLabel: "developers.circle.com",
    icon: <WalletCards size={17} />,
  },
  {
    key: "aa",
    origin: "ERC standard",
    name: "ERC-4337 + ERC-1967",
    description:
      "Each Circle wallet deploys as an ERC-1967 proxy over Circle's modular smart-account implementation and transacts as ERC-4337 user operations — it's why Arcscan labels Splitsy wallets ERC1967Proxy.",
    proof: "ERC1967Proxy → circle_6900_singleowner_v3",
    href: "https://developers.circle.com/wallets/account-types",
    linkLabel: "developers.circle.com",
    icon: <Layers size={17} />,
  },
  {
    key: "cctp",
    origin: "Circle",
    name: "CCTP v2 bridging",
    description:
      "When someone's USDC sits on another chain, Splitsy pulls it in with Circle's native burn-and-mint protocol via App Kit — from six testnet chains, no wrapped assets, no third-party bridge.",
    proof: "approve → burn → attest → mint",
    href: "https://developers.circle.com/cctp",
    linkLabel: "developers.circle.com",
    icon: <ArrowLeftRight size={17} />,
  },
  {
    key: "erc8004",
    origin: "ERC standard",
    name: "ERC-8004 payment reputation",
    description:
      "Paying your share earns portable, verifiable reputation on the ERC-8004 registries Arc pre-deploys. Payers own their identity NFT, and each due-date-graded score commits a hash anyone can recompute against the exact payment it grades.",
    proof: 'IdentityRegistry 0x8004A818… · keccak256("splitsy:bill:<id>:<payTx>")',
    href: "https://docs.arc.io/arc/tutorials/register-your-first-ai-agent",
    linkLabel: "docs.arc.io",
    icon: <BadgeCheck size={17} />,
    wide: true,
  },
  {
    key: "scp",
    origin: "Circle",
    name: "Smart Contract Platform",
    description:
      "A Circle event monitor watches the registry's DebtPaid event, so payments sent straight from browser wallets — which never touch Splitsy's servers — still fire webhooks and earn reputation.",
    proof: "contracts.eventLog → /api/webhooks/circle",
    href: "https://developers.circle.com/contracts/scp-event-monitoring",
    linkLabel: "developers.circle.com",
    icon: <Webhook size={17} />,
  },
];

// The credibility section: the demo above runs on real rails, and each card
// names one of them, shows its on-chain/config receipt, and links to the docs.
export function SectionStack() {
  const rootRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const root = rootRef.current;
    if (!root) return;

    const ctx = gsap.context(() => {
      gsap.from("[data-stack-heading]", {
        y: 26,
        autoAlpha: 0,
        duration: 0.8,
        ease: "expo.out",
        scrollTrigger: { trigger: root, start: "top 74%" },
      });
      gsap.from("[data-stack-card]", {
        y: 24,
        autoAlpha: 0,
        duration: 0.7,
        ease: "expo.out",
        stagger: 0.08,
        scrollTrigger: { trigger: root, start: "top 62%" },
      });
    }, root);

    return () => ctx.revert();
  }, []);

  return (
    <section
      aria-labelledby="stack-heading"
      className="mx-auto w-full max-w-[80rem] scroll-mt-24 px-4 pb-[var(--lp-section-y)] sm:px-6 lg:px-8"
      id="stack"
      ref={rootRef}
    >
      <h2 className="lp-display-lg max-w-3xl" data-stack-heading id="stack-heading">
        Built on Circle. <span className="lp-headline-accent">Settled on Arc.</span>
      </h2>
      <p className="lp-lede mt-5 max-w-2xl" data-stack-heading>
        No mock rails under the demo! Circle&apos;s wallet and transfer infrastructure composed with
        Arc&apos;s stablecoin-native chain and open Ethereum standards. Every card links to the docs.
      </p>

      <ul className="mt-12 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 lg:grid-cols-3">
        {STACK.map((tech) => (
          <li className={tech.wide ? "sm:col-span-2" : undefined} data-stack-card key={tech.key}>
            <motion.a
              className="group flex h-full flex-col rounded-[calc(var(--radius)+4px)] border border-[var(--border)] bg-[var(--surface)] p-5 no-underline shadow-[var(--shadow-soft)] backdrop-blur-xl"
              href={tech.href}
              rel="noopener noreferrer"
              target="_blank"
              transition={{ type: "spring", stiffness: 320, damping: 22 }}
              whileHover={reduced ? undefined : { y: -4, scale: 1.01 }}
            >
              <span className="flex items-center justify-between">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface-strong)] text-[var(--text-soft)]">
                  {tech.icon}
                </span>
                <span className="text-[0.62rem] font-extrabold uppercase tracking-[0.08em] text-[var(--text-muted)]">
                  {tech.origin}
                </span>
              </span>

              <span className="mt-4 block text-sm font-bold text-[var(--text)]">{tech.name}</span>
              <span className="mt-1 block text-sm text-[var(--text-muted)]">{tech.description}</span>
              <span className="mono mt-4 block truncate text-xs text-[var(--text-muted)]">{tech.proof}</span>

              <span className="mt-auto flex items-center gap-1 pt-4 text-xs font-semibold text-[var(--accent)]">
                {tech.linkLabel}
                <ArrowUpRight
                  className="transition-transform duration-[var(--dur-2)] group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
                  size={13}
                />
              </span>
            </motion.a>
          </li>
        ))}
      </ul>
    </section>
  );
}
