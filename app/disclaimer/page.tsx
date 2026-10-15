import Link from "next/link";

import { LegalDoc, type LegalClause } from "@/components/LegalDoc";
import { ARC, ARC_LABEL, forArcNetwork } from "@/lib/arc-chain";
import { walletProviderName } from "@/lib/wallet-provider";

// Render at request time so the nonce-based CSP (see proxy.ts) is applied to
// this page's framework scripts.
export const dynamic = "force-dynamic";

// THE TWO FACTS THIS PAGE TURNS ON, both read from the running deployment rather
// than typed in. A disclaimer that describes the wrong network or the wrong
// custody model is not a stale page, it is a false statement about somebody's
// money — in the direction that reassures, which is the dangerous one.
//
// walletProviderName() is server-only and this is a server component, so no
// NEXT_PUBLIC twin is needed and nothing here reaches the browser bundle.
const ON_MAINNET = ARC.network === "mainnet";
const ON_PRIVY = walletProviderName() === "privy";

export const metadata = {
  title: "Disclaimer & acknowledgments",
  description: forArcNetwork(
    "Splitsy is experimental software on Arc. It moves real USDC, is not affiliated with any referenced brand, and is not financial advice.",
    "Splitsy is an experimental demo on Arc Testnet. It uses test USDC only, involves no real funds, is not affiliated with any referenced brand, and is not financial advice.",
  ),
  alternates: { canonical: "/disclaimer" },
  robots: { index: true, follow: true },
};

// The page is the content, and the shell (components/LegalDoc.tsx) is the design.
// Splitting them this way is what lets a clause be edited by someone reading it as
// prose: there is no markup here that is not a paragraph, a list, or a link.
//
// The ids are the anchors. They are linked from the index above and, in principle,
// from anywhere — so renaming one breaks a link and reordering the array does not.
const CLAUSES: LegalClause[] = [
  {
    id: "experimental",
    title: "Experimental software",
    body: (
      <p>
        Splitsy is a prototype provided for demonstration and educational purposes. It is offered{" "}
        <strong>&quot;as is&quot;</strong> and <strong>&quot;as available&quot;</strong>, may change, break, or be
        taken offline without notice, and makes no guarantee of availability, accuracy, or fitness for any
        particular purpose. Do not rely on it for production use or for managing anything of value.
      </p>
    ),
  },
  {
    // The id stays "testnet" on both networks on purpose: nothing in the repo
    // links to #testnet, but an anchor that has been live is a URL somebody may
    // hold, and a dead fragment is worse than an oddly-named live one.
    id: "testnet",
    title: ON_MAINNET ? "Real funds — payments are final" : "Testnet only — no real funds",
    body: (
      <>
        {ON_MAINNET ? (
          <p>
            Splitsy operates on <strong>Arc</strong>, a live network. All balances, payments, and recurring tabs
            use <strong>real USDC</strong>. Payments are <strong>final and cannot be reversed</strong> — not by
            the recipient, not by us. Send only what you can afford to lose, and check every address before you
            confirm: a share paid to the wrong one is gone.
          </p>
        ) : (
          <p>
            Splitsy operates exclusively on <strong>Arc Testnet</strong>. All balances, payments, and recurring
            tabs use <strong>test USDC</strong>, which has <strong>no monetary value</strong> and cannot be
            redeemed for real money. Never send mainnet assets, real USDC, or real funds to any address shown in
            this app.
          </p>
        )}
        <aside className="doc-note">
          <span className="settle-label">Onchain actions are irreversible</span>
          <p>
            Transactions you sign are broadcast to a public {forArcNetwork("", "test ")}blockchain and cannot be
            undone. Always review every wallet prompt — the amount, the contract, and the network — before
            approving.
          </p>
        </aside>
      </>
    ),
  },
  {
    id: "affiliation",
    title: "No affiliation & trademark acknowledgment",
    body: (
      <>
        <p>
          Splitsy is an <strong>independent project</strong>. It is{" "}
          <strong>not affiliated with, endorsed by, or sponsored by</strong> Circle Internet Financial, Arc,
          USDC, MetaMask, X/Twitter, Discord, Google, or any other company, protocol, or product referenced in
          this application or its documentation.
        </p>
        <p>
          All product names, logos, and trademarks are the property of their respective owners. They are
          referenced only to describe interoperability and functionality. Splitsy has{" "}
          <strong>no intent to impersonate, mimic, or pass itself off</strong> as any other brand, website, or
          service. If you are a rights holder and have a concern, please contact us at{" "}
          <a href="mailto:support@splitsy.xyz">support@splitsy.xyz</a>.
        </p>
      </>
    ),
  },
  {
    id: "not-advice",
    title: "Not financial, legal, or tax advice",
    body: (
      <p>
        Nothing in Splitsy constitutes financial, investment, legal, accounting, or tax advice. The receipt
        scanner, currency conversion, and split calculations are convenience features and are not an accounting
        authority. Always review extracted data and confirm amounts yourself before acting on them.
      </p>
    ),
  },
  {
    id: "no-warranty",
    title: "No warranty & limitation of liability",
    body: (
      <p>
        To the maximum extent permitted by law, Splitsy and its contributors disclaim all warranties, express or
        implied, and accept no liability for any loss or damage arising from your use of the app, including
        interactions with third-party wallets, networks, bridges, or smart contracts. You use Splitsy at your
        own risk.
      </p>
    ),
  },
  {
    id: "privacy-wallets",
    title: "Privacy & wallets",
    body: (
      <ul>
        <li>
          <strong>Sign-in</strong> (via X, Discord, Google, or a one-time email code) is used only to identify
          you. Splitsy reads just the basic profile from your chosen provider — an id/handle or email address,
          plus display name and avatar — and never posts on your behalf. X and Discord sign-in do not share your
          email; Google and email sign-in identify you <strong>by</strong> your email address.
        </li>
        <li>
          If you connect a <strong>browser wallet</strong> instead, that wallet signs every action and Splitsy
          never holds its keys. If you sign in with a provider above, a wallet is created for your identity on{" "}
          {ARC_LABEL}
          {ON_PRIVY ? (
            <>
              {" "}
              by <strong>Privy</strong>. You own it: every payment is confirmed in Privy&apos;s own prompt, and
              you can export the private key and take the wallet with you.
            </>
          ) : (
            <>
              {" "}
              by <strong>Circle</strong> and operated on your behalf, gated by a PIN you set.
            </>
          )}
        </li>
        <li>
          Receipt images you upload are sent to the server only to perform optical character recognition (OCR)
          and are not persisted after processing.
        </li>
        <li>
          Wallet addresses, amounts, and bill metadata submitted on-chain are written to a public{" "}
          {forArcNetwork("", "test ")}blockchain and are inherently visible to anyone — do not include sensitive
          personal information.
        </li>
        <li>
          Paying an on-chain bill in full records a{" "}
          <strong>public, positive-only payment-reputation entry</strong>{" "}
          (an identity token plus a timeliness score anchored to the payment transaction) on Arc&apos;s ERC-8004
          registries. Only payments your wallet itself makes create reputation — being tagged into a bill never
          does — and like all on-chain data these records cannot be deleted.
        </li>
        <li>
          Full details are in our <Link href="/legal">Terms &amp; Privacy</Link>.
        </li>
      </ul>
    ),
  },
  {
    id: "security",
    title: "Security contact",
    body: (
      <p>
        If you discover a security issue, please report it to{" "}
        <a href="mailto:security@splitsy.xyz">security@splitsy.xyz</a>. Our machine-readable policy is published
        at <a href="/.well-known/security.txt">/.well-known/security.txt</a>. For general questions, contact{" "}
        <a href="mailto:support@splitsy.xyz">support@splitsy.xyz</a>.
      </p>
    ),
  },
];

export default function DisclaimerPage() {
  return (
    <LegalDoc
      clauses={CLAUSES}
      colophon={
        <p>
          This page is the short version of what Splitsy is and is not. The binding version — what you agree to
          by using the app, and exactly what data it handles — is the combined{" "}
          <Link href="/legal">Terms of Service and Privacy Policy</Link>. For anything else, write to{" "}
          <a href="mailto:support@splitsy.xyz">support@splitsy.xyz</a>.
        </p>
      }
      eyebrow="Legal & transparency"
      glance={[
        { label: "Status", value: "Experimental software" },
        { label: "Network", value: ARC_LABEL },
        {
          label: "Funds",
          value: forArcNetwork("Real USDC — payments are final", "Test USDC only — no real value"),
        },
        { label: "Affiliation", value: "Independent project" },
      ]}
      lede={
        ON_MAINNET ? (
          <>
            Splitsy is an independent, experimental project. It runs on <strong>Arc</strong> with{" "}
            <strong>real USDC</strong>, payments it makes <strong>cannot be reversed</strong>, and it is not
            affiliated with any of the brands or networks it interoperates with. Please read the clauses below
            before using it.
          </>
        ) : (
          <>
            Splitsy is an independent, experimental demo. It runs on <strong>Arc Testnet</strong> with test USDC
            that has no monetary value, involves <strong>no real funds</strong>, and is not affiliated with any
            of the brands or networks it interoperates with. Please read the clauses below before using it.
          </>
        )
      }
      sibling={{ href: "/legal", label: "Terms & Privacy" }}
      title={
        <>
          Disclaimer &amp; <span className="lp-headline-accent">acknowledgments.</span>
        </>
      }
      updated="2026-07-20"
    />
  );
}
