"use client";

import { ArrowUpRight } from "lucide-react";

import { PRICES } from "@/lib/x402/pricing";

import { useReveal } from "./useReveal";

type Tech = {
  key: string;
  origin: "Arc" | "Circle" | "ERC standard";
  name: string;
  description: string;
  proof: string;
  href: string;
  linkLabel: string;
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
  },
  {
    key: "x402",
    origin: "Circle",
    name: "x402 machine payments",
    description:
      "Splitsy's own /api/ocr, /api/fx and /api/agents/review answer HTTP 402 with the terms of the call. A buying agent signs an offchain EIP-3009 authorization instead of sending a transaction, so it pays for the API in USDC and spends no gas doing it.",
    proof: `402 → payment-signature → 200 · ${PRICES["/api/ocr"]} per scan`,
    href: "https://developers.circle.com/gateway/nanopayments/concepts/x402",
    linkLabel: "developers.circle.com",
  },
  {
    key: "nanopayments",
    origin: "Circle",
    name: "Gateway batched settlement",
    description:
      "The facilitator verifies each authorization and settles net positions in bulk, paying gas once per batch instead of once per payment. That is what makes a half-cent API call worth charging for at all.",
    proof: "GatewayWalletBatched v1 · 0x0077…19B9",
    href: "https://developers.circle.com/gateway/nanopayments/concepts/batched-settlement",
    linkLabel: "developers.circle.com",
  },
  {
    key: "erc8183",
    origin: "ERC standard",
    name: "ERC-8183 agent jobs",
    description:
      "A settlement is not a hidden server call. Your agent opens a job on Arc's AgenticCommerce deployment and escrows the fee, a second agent does the work, and a third is paid to read the registry and release the escrow only if the debt really settled.",
    proof: "AgenticCommerce 0x0747…4583 · client / provider / evaluator",
    href: "https://docs.arc.io/arc/tutorials/create-your-first-erc-8183-job",
    linkLabel: "docs.arc.io",
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
  },
  {
    key: "paymaster",
    origin: "Circle",
    name: "Paymaster gas in USDC",
    description:
      "Bridging in normally needs that chain's own gas token. Circle's Paymaster lets the browser wallet pay the fee in USDC instead, funded by an EIP-2612 permit and run as an EIP-7702 authorization on the user's own address.",
    proof: "Paymaster v0.8 0x3BA9…8966 · EIP-7702 + EIP-2612",
    href: "https://developers.circle.com/paymaster",
    linkLabel: "developers.circle.com",
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
  },
];

// The credibility section: the demo above runs on real rails, and each row names
// one of them, shows its on-chain/config receipt, and links to the docs.
//
// It was eleven glass cards on a three-column grid that lifted on hover, with a
// bordered icon circle apiece — the densest patch of chrome left on the page, and
// a grid of equal boxes says nothing about a stack. Now it is what it is: a ruled
// list, one row per rail, grouped by who provides it.
export function SectionStack() {
  const ref = useReveal<HTMLElement>("top 78%");

  return (
    <section aria-labelledby="stack-heading" className="bill-poster scroll-mt-24" id="stack" ref={ref}>
      <div className="lp-measure">
        <div className="bill-poster-head">
          <span className="settle-label" data-reveal="item">
            <span className="lp-step">09</span> The stack
          </span>
          <span className="bill-poster-fact" data-reveal="item">
            <b>{STACK.length}</b> rails · every row links to its docs
          </span>
        </div>
        <h2 className="lp-display-lg mt-4 max-w-4xl" data-reveal="lead" id="stack-heading">
          Built on Circle. <span className="lp-headline-accent">Settled on Arc.</span>
        </h2>
        <p className="lp-lede mt-5 max-w-2xl" data-reveal="lead">
          No mock rails under the demo — Circle&apos;s wallet and transfer infrastructure composed with
          Arc&apos;s stablecoin-native chain and open Ethereum standards.
        </p>

        <ul className="lp-rows bill-poster-body list-none p-0">
          {STACK.map((tech) => (
            <li data-reveal="item" key={tech.key}>
              <a
                className="lp-row grid-cols-1 lg:grid-cols-[minmax(0,7rem)_minmax(0,1fr)_minmax(0,18rem)]"
                href={tech.href}
                rel="noopener noreferrer"
                target="_blank"
              >
                <span className="settle-label">{tech.origin}</span>
                <span className="min-w-0">
                  <span className="block text-[1.05rem] text-[var(--pay-poster-fg)]">{tech.name}</span>
                  <span className="lp-row-body mt-1 block">{tech.description}</span>
                </span>
                <span className="min-w-0">
                  <span className="lp-row-proof block">{tech.proof}</span>
                  <span className="settle-label mt-2 inline-flex items-baseline gap-1">
                    {tech.linkLabel}
                    <ArrowUpRight className="lp-row-out self-center" size={12} />
                  </span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
