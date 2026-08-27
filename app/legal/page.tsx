import Link from "next/link";

import { LegalDoc, type LegalClause } from "@/components/LegalDoc";

// Render at request time so the nonce-based CSP (see proxy.ts) is applied to
// this page's framework scripts.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Terms & Privacy",
  description:
    "The combined Terms of Service and Privacy Policy for Splitsy — an experimental bill-splitting demo on Arc Testnet that uses test USDC only and collects only the profile from the sign-in provider you choose (X, Discord, Google, or email).",
  alternates: { canonical: "/legal" },
  robots: { index: true, follow: true },
};

// One array, three parts, nineteen clauses. The shell (components/LegalDoc.tsx)
// numbers them and builds the index from the same list, so the number beside a
// clause and the number in the contents cannot disagree.
//
// Two ids are load-bearing beyond this file: `privacy` and `terms` were the
// section anchors the previous version of this page published, and next.config.ts
// still redirects /privacy and /terms here. They keep their names so nothing that
// already links to a part of this document lands nowhere.
const CLAUSES: LegalClause[] = [
  // ── Privacy ──────────────────────────────────────────────────────────────
  {
    id: "privacy",
    part: "Privacy",
    title: "About this policy",
    body: (
      <p>
        Splitsy (&quot;we&quot;, &quot;us&quot;) provides a prototype for scanning receipts, splitting shared
        costs, and settling <strong>test USDC</strong> payments on Arc Testnet. It is offered for demonstration
        and educational purposes only and involves <strong>no real funds</strong>. By using Splitsy you agree to
        this policy and to the <a href="#terms">Terms of Service</a> below. If you do not agree, please do not
        use the app.
      </p>
    ),
  },
  {
    id: "sign-in",
    part: "Privacy",
    title: "How you sign in",
    body: (
      <>
        <p>
          Splitsy offers four sign-in methods; you choose one. In every case we use the sign-in{" "}
          <strong>solely to identify you</strong> — we never post on your behalf, read your messages, or collect
          any content beyond the basic profile described here.
        </p>
        <ul>
          <li>
            <strong>X</strong> — OAuth 2.0 with the read-only scopes <code>tweet.read</code>,{" "}
            <code>users.read</code>, and <code>offline.access</code> (to keep your session alive). A single call
            to <code>GET&nbsp;/2/users/me</code> returns your user ID, username (handle), display name, and
            avatar URL. We <strong>do not</strong> request your email and <strong>do not</strong> read your
            timeline, follows, likes, or direct messages.
          </li>
          <li>
            <strong>Discord</strong> — OAuth 2.0 with the <code>identify</code> scope. We receive your user ID,
            username, display name, and avatar. We do <strong>not</strong> request the <code>email</code> scope
            or read your servers, messages, or connections.
          </li>
          <li>
            <strong>Google</strong> — OAuth 2.0 (OpenID Connect). We receive your{" "}
            <strong>verified email address</strong>, name, and profile picture. We require a verified email
            because it is your identity key.
          </li>
          <li>
            <strong>Email</strong> — you enter an email address and we send a one-time 6-digit code (via our
            email provider, Resend). Verifying it signs you in. We store your email address and a short-lived
            salted hash of the code.
          </li>
        </ul>
        <p>
          We use this data only to (1) authenticate you, (2) show your handle, name, or email and avatar in the
          app, and (3) match you to shared bills that others tag you in, so you can view and settle what you owe.
          Google and email sign-in resolve to the <strong>same</strong> email-keyed identity — signing in either
          way with the same address is the same Splitsy account and wallet.
        </p>
        <aside className="doc-note">
          <span className="settle-label">Revoking access</span>
          <p>
            For X, Discord, and Google you can revoke Splitsy&apos;s access at any time from that
            provider&apos;s connected-apps settings. For email sign-in there is nothing persistent to revoke —
            one-time codes expire in minutes.
          </p>
        </aside>
      </>
    ),
  },
  {
    id: "collect",
    part: "Privacy",
    title: "Information we collect",
    body: (
      <ul>
        <li>
          <strong>Account &amp; identity data</strong> — the sign-in data above for your chosen provider (an
          id/handle or email, plus name and avatar), used to create and identify your Splitsy account. If you use
          Google or email sign-in, this includes your <strong>email address</strong>.
        </li>
        <li>
          <strong>Wallet data</strong> — the address and identifier of the Circle wallet created for your
          account, so we can attribute bills, debts, and payments to you.
        </li>
        <li>
          <strong>Wallet PIN</strong> — stored only as a salted <code>scrypt</code> hash. Your raw PIN is never
          stored or transmitted in readable form.
        </li>
        <li>
          <strong>Receipt images</strong> — sent to our server only to perform optical character recognition
          (OCR); processed transiently and <strong>not persisted</strong> after the scan completes.
        </li>
        <li>
          <strong>Bill &amp; split data</strong> — merchant names, amounts, line items, participants, and
          payment status you create or that others share with you.
        </li>
        <li>
          <strong>Onchain data</strong> — bills, debts, and payments submitted to Arc Testnet are written to a
          public blockchain and are inherently visible to anyone.
        </li>
        <li>
          <strong>Payment reputation</strong> — when your wallet pays an on-chain bill in full, an identity token
          and a positive, scored feedback record (bill reference, timeliness score, and payment transaction) are
          written to Arc&apos;s public ERC-8004 registries, and mirrored in our database for display. Reputation
          is created <strong>only by payments your wallet itself makes</strong> — being tagged into a bill
          records nothing — and having no history is always shown as neutral.
        </li>
      </ul>
    ),
  },
  {
    id: "use",
    part: "Privacy",
    title: "How we use your information",
    body: (
      <>
        <ul>
          <li>To authenticate you and operate your account.</li>
          <li>To create and operate a wallet so you can view, receive, and settle debts.</li>
          <li>To match you to bills split with you and calculate what you owe or are owed.</li>
          <li>To extract structured data from receipts you upload.</li>
          <li>To maintain the security and integrity of the service.</li>
        </ul>
        <p>
          We do <strong>not</strong> use your data for advertising, profiling, or automated decision-making, and
          we do not build marketing profiles from your sign-in data.
        </p>
      </>
    ),
  },
  {
    id: "wallet",
    part: "Privacy",
    title: "Your wallet",
    body: (
      <p>
        On first sign-in we create a <strong>Circle developer-controlled wallet</strong> on Arc Testnet keyed to
        your provider identity (your X or Discord id, or your email address for Google/email sign-in), so you can
        pay and get paid in USDC with no crypto setup. Because this is a testnet demo using{" "}
        <strong>test USDC with no monetary value</strong>, the wallet is operated server-side on your behalf.
        Sending USDC is protected by a wallet PIN that you set. A future mainnet version would offer genuine
        self-custody for real funds.
      </p>
    ),
  },
  {
    id: "share",
    part: "Privacy",
    title: "How we share information",
    body: (
      <p>
        We <strong>do not sell, rent, or trade</strong>{" "}
        your personal data, and we do not transfer your sign-in data to any third party for their independent
        use. We share data only with the service providers that run the app — our hosting provider, our database
        provider, the OCR service that processes receipts, our email provider (Resend, for email one-time codes),
        and Circle&apos;s wallet infrastructure — and only to the extent needed to provide those functions. Data
        written to the public blockchain is, by nature, publicly visible.
      </p>
    ),
  },
  {
    id: "retention",
    part: "Privacy",
    title: "Data retention & deletion",
    body: (
      <p>
        We retain account and bill data for as long as your account is active. You may request deletion of your
        account and associated sign-in data at any time by emailing{" "}
        <a href="mailto:privacy@splitsy.xyz">privacy@splitsy.xyz</a>. We will delete the data we control, though
        information already written to a public blockchain — including payment-reputation records on the ERC-8004
        registries — cannot be removed.
      </p>
    ),
  },

  // ── Terms ────────────────────────────────────────────────────────────────
  {
    id: "terms",
    part: "Terms",
    title: "Acceptance",
    body: (
      <p>
        By accessing or using Splitsy (the &quot;Service&quot;), you agree to be bound by these Terms of Service
        and the <a href="#privacy">Privacy Policy</a> above, together with our{" "}
        <Link href="/disclaimer">Disclaimer &amp; acknowledgments</Link>. If you use the Service on behalf of an
        organization, you represent that you have authority to bind that organization.
      </p>
    ),
  },
  {
    id: "terms-testnet",
    part: "Terms",
    title: "Experimental service — testnet only",
    body: (
      <p>
        Splitsy is a prototype for demonstration and educational purposes, operating exclusively on{" "}
        <strong>Arc Testnet</strong>. All balances, payments, and tabs use <strong>test USDC</strong>, which has{" "}
        <strong>no monetary value</strong> and cannot be redeemed for real money. Never send mainnet assets or
        real funds to any address shown in the app. Onchain transactions are irreversible.
      </p>
    ),
  },
  {
    id: "eligibility",
    part: "Terms",
    title: "Eligibility & accounts",
    body: (
      <p>
        You must be at least the age of majority in your jurisdiction to use the Service. You are responsible for
        activity under your account and for keeping access to your account, wallet, and wallet PIN secure.
      </p>
    ),
  },
  {
    id: "wallet-pin",
    part: "Terms",
    title: "Wallet & PIN",
    body: (
      <p>
        A Circle wallet is created for your account to send and receive test USDC on Arc Testnet. You set a
        wallet PIN that is required to send funds; keep it secret. Because the Service is a testnet demo with
        valueless test USDC, the wallet is operated on your behalf and Splitsy is not liable for any test
        balances.
      </p>
    ),
  },
  {
    id: "acceptable-use",
    part: "Terms",
    title: "Acceptable use",
    body: (
      <>
        <p>You agree not to:</p>
        <ul>
          <li>Use the Service for any unlawful, fraudulent, or abusive purpose.</li>
          <li>Attempt to disrupt, overload, reverse-engineer, or gain unauthorized access to the Service.</li>
          <li>Upload content you do not have the right to submit, or that contains others&apos; sensitive data.</li>
          <li>Misrepresent your identity or impersonate another person or entity.</li>
          <li>Use the Service to manage anything of real value or rely on it for production purposes.</li>
        </ul>
      </>
    ),
  },
  {
    id: "terms-not-advice",
    part: "Terms",
    title: "Not financial, legal, or tax advice",
    body: (
      <p>
        Nothing in the Service constitutes financial, investment, legal, accounting, or tax advice. The receipt
        scanner, currency conversion, and split calculations are convenience features only. Always review
        extracted data and confirm amounts yourself before acting on them.
      </p>
    ),
  },
  {
    id: "no-warranty",
    part: "Terms",
    title: "No warranty",
    body: (
      <p>
        The Service is provided <strong>&quot;as is&quot;</strong> and <strong>&quot;as available&quot;</strong>{" "}
        without warranties of any kind, express or implied, including merchantability, fitness for a particular
        purpose, and non-infringement. We do not warrant that the Service will be uninterrupted, secure, or
        error-free, and it may change, break, or be taken offline without notice.
      </p>
    ),
  },
  {
    id: "liability",
    part: "Terms",
    title: "Limitation of liability",
    body: (
      <p>
        To the maximum extent permitted by law, Splitsy and its contributors will not be liable for any indirect,
        incidental, special, consequential, or exemplary damages, or for any loss arising from your use of the
        Service, including interactions with third-party wallets, networks, bridges, or smart contracts. You use
        the Service at your own risk.
      </p>
    ),
  },
  {
    id: "third-party",
    part: "Terms",
    title: "Third-party services & no affiliation",
    body: (
      <p>
        The Service interoperates with third-party providers (for example, X, Discord, and Google for sign-in,
        Resend for email one-time codes, Circle wallet and blockchain infrastructure, and an OCR provider). Your
        use of those services is governed by their respective terms. Splitsy is an independent project and is{" "}
        <strong>not affiliated with, endorsed by, or sponsored by</strong> X/Twitter, Discord, Google, Circle,
        Arc, USDC, or any other referenced brand. All trademarks belong to their respective owners.
      </p>
    ),
  },
  {
    id: "termination",
    part: "Terms",
    title: "Termination",
    body: (
      <p>
        We may suspend or terminate access to the Service at any time, with or without notice, including for
        violation of these terms. You may stop using the Service and request deletion of your account at any
        time.
      </p>
    ),
  },

  // ── Both parts ───────────────────────────────────────────────────────────
  {
    id: "security",
    part: "Shared",
    title: "Security",
    body: (
      <p>
        We use reasonable technical and organizational measures to protect your data, including HMAC-signed
        http-only session cookies and a salted hash for your wallet PIN. However, no method of transmission or
        storage is completely secure, and this is experimental software provided &quot;as is&quot;. If you
        discover a security issue, please report it to{" "}
        <a href="mailto:security@splitsy.xyz">security@splitsy.xyz</a>.
      </p>
    ),
  },
  {
    id: "changes",
    part: "Shared",
    title: "Changes & contact",
    body: (
      <p>
        We may update these terms and this policy from time to time. Material changes will be reflected by
        updating the date printed on the contents above, and continued use of the Service constitutes acceptance.
        For privacy requests, contact <a href="mailto:privacy@splitsy.xyz">privacy@splitsy.xyz</a>; for anything
        else, <a href="mailto:support@splitsy.xyz">support@splitsy.xyz</a>.
      </p>
    ),
  },
];

export default function LegalPage() {
  return (
    <LegalDoc
      clauses={CLAUSES}
      colophon={
        <p>
          These terms bind you to the Service. What the Service actually <em>is</em> — an experimental testnet
          demo, unaffiliated with any brand it names, holding no money worth holding — is set out plainly in the{" "}
          <Link href="/disclaimer">Disclaimer &amp; acknowledgments</Link>. For privacy requests write to{" "}
          <a href="mailto:privacy@splitsy.xyz">privacy@splitsy.xyz</a>, for security to{" "}
          <a href="mailto:security@splitsy.xyz">security@splitsy.xyz</a>, and for anything else to{" "}
          <a href="mailto:support@splitsy.xyz">support@splitsy.xyz</a>.
        </p>
      }
      eyebrow="Legal & transparency"
      glance={[
        { label: "We sell your data?", value: "Never" },
        { label: "Sign-in data used for", value: "Sign-in & matching only" },
        { label: "Email collected?", value: "Only with Google or email sign-in" },
        { label: "Funds", value: "Test USDC — no real value" },
      ]}
      lede={
        <>
          Splitsy is an independent, experimental demo on <strong>Arc Testnet</strong> using test USDC with no
          monetary value. These combined terms and privacy policy explain the rules of using the app and exactly
          what data it handles — in short: it collects only the basic profile from the sign-in method you choose
          (<strong>X, Discord, Google, or email</strong>), and never posts on your behalf.
        </>
      }
      sibling={{ href: "/disclaimer", label: "Disclaimer" }}
      title={
        <>
          Terms of Service &amp; <span className="lp-headline-accent">Privacy Policy.</span>
        </>
      }
      updated="2026-07-20"
    />
  );
}
