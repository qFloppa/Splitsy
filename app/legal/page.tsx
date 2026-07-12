import Link from "next/link";
import Image from "next/image";
import DocsShell from "../docs/DocsShell";
import {
  AlertTriangle,
  AtSign,
  Ban,
  Database,
  Eye,
  FileText,
  FlaskConical,
  Gavel,
  KeyRound,
  LockKeyhole,
  RefreshCw,
  Scale,
  Share2,
  ShieldOff,
  Trash2,
  UserCheck,
  Wallet,
} from "lucide-react";

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

export default function LegalPage() {
  return (
    <DocsShell>
      <header className="docs-hero">
        <nav className="docs-topbar" aria-label="Legal navigation">
          <Link href="/" className="docs-brand">
            <span className="logo-crop logo-crop-docs">
              <Image alt="Splitsy" className="logo-crop-image" height={1024} priority src="/splitsy.png" width={1536} />
            </span>
          </Link>
          <div className="docs-toplinks">
            <a href="#privacy">Privacy</a>
            <a href="#terms">Terms</a>
            <Link href="/">Open app</Link>
          </div>
        </nav>

        <div className="docs-hero-grid">
          <div>
            <p className="docs-eyebrow">Legal &amp; transparency</p>
            <h1>Terms of Service &amp; Privacy Policy.</h1>
            <p className="docs-lede">
              Splitsy is an independent, experimental demo on <strong>Arc Testnet</strong> using test USDC with no monetary
              value. These combined terms and privacy policy explain the rules of using the app and exactly what data it
              handles — in short: it collects only the basic profile from the sign-in method you choose (<strong>X, Discord,
              Google, or email</strong>), and never posts on your behalf.
            </p>
          </div>

          <aside className="docs-hero-panel" aria-label="At a glance">
            <div>
              <span>We sell your data?</span>
              <strong>Never</strong>
            </div>
            <div>
              <span>Sign-in data used for</span>
              <strong>Sign-in &amp; matching only</strong>
            </div>
            <div>
              <span>Email collected?</span>
              <strong>Only if you sign in with Google or email</strong>
            </div>
            <div>
              <span>Funds</span>
              <strong>Test USDC — no real value</strong>
            </div>
          </aside>
        </div>
      </header>

      <div className="docs-layout">
        <article className="docs-content" style={{ gridColumn: "1 / -1" }}>
          {/* ---------------------------------------------------------------- */}
          {/* PRIVACY */}
          {/* ---------------------------------------------------------------- */}
          <section id="privacy" className="docs-section">
            <Heading icon={<FlaskConical size={20} />} title="Privacy: about this policy" />
            <p>
              Splitsy (&quot;we&quot;, &quot;us&quot;) provides a prototype for scanning receipts, splitting shared costs,
              and settling <strong>test USDC</strong> payments on Arc Testnet. It is offered for demonstration and educational
              purposes only and involves <strong>no real funds</strong>. By using Splitsy you agree to this policy and to the{" "}
              <a href="#terms">Terms of Service</a> below. If you do not agree, please do not use the app.
            </p>
          </section>

          <section className="docs-section">
            <Heading icon={<AtSign size={20} />} title="How you sign in" />
            <p>
              Splitsy offers four sign-in methods; you choose one. In every case we use the sign-in{" "}
              <strong>solely to identify you</strong> — we never post on your behalf, read your messages, or collect any
              content beyond the basic profile described here.
            </p>
            <ul className="docs-list">
              <li>
                <strong>X</strong> — OAuth 2.0 with the read-only scopes <code>tweet.read</code>, <code>users.read</code>, and{" "}
                <code>offline.access</code> (to keep your session alive). A single call to <code>GET&nbsp;/2/users/me</code>{" "}
                returns your user ID, username (handle), display name, and avatar URL. We <strong>do not</strong> request your
                email and <strong>do not</strong> read your timeline, follows, likes, or direct messages.
              </li>
              <li>
                <strong>Discord</strong> — OAuth 2.0 with the <code>identify</code> scope. We receive your user ID, username,
                display name, and avatar. We do <strong>not</strong> request the <code>email</code> scope or read your servers,
                messages, or connections.
              </li>
              <li>
                <strong>Google</strong> — OAuth 2.0 (OpenID Connect). We receive your <strong>verified email address</strong>,
                name, and profile picture. We require a verified email because it is your identity key.
              </li>
              <li>
                <strong>Email</strong> — you enter an email address and we send a one-time 6-digit code (via our email provider,
                Resend). Verifying it signs you in. We store your email address and a short-lived salted hash of the code.
              </li>
            </ul>
            <p>
              We use this data only to (1) authenticate you, (2) show your handle, name, or email and avatar in the app, and
              (3) match you to shared bills that others tag you in, so you can view and settle what you owe. Google and email
              sign-in resolve to the <strong>same</strong> email-keyed identity — signing in either way with the same address
              is the same Splitsy account and wallet.
            </p>
            <Callout title="Revoking access">
              For X, Discord, and Google you can revoke Splitsy&apos;s access at any time from that provider&apos;s connected-apps
              settings. For email sign-in there is nothing persistent to revoke — one-time codes expire in minutes.
            </Callout>
          </section>

          <section className="docs-section">
            <Heading icon={<Database size={20} />} title="Information we collect" />
            <ul className="docs-list">
              <li>
                <strong>Account &amp; identity data</strong> — the sign-in data above for your chosen provider (an id/handle or
                email, plus name and avatar), used to create and identify your Splitsy account. If you use Google or email
                sign-in, this includes your <strong>email address</strong>.
              </li>
              <li>
                <strong>Wallet data</strong> — the address and identifier of the Circle wallet created for your account, so we
                can attribute bills, debts, and payments to you.
              </li>
              <li>
                <strong>Wallet PIN</strong> — stored only as a salted <code>scrypt</code> hash. Your raw PIN is never stored or
                transmitted in readable form.
              </li>
              <li>
                <strong>Receipt images</strong> — sent to our server only to perform optical character recognition (OCR);
                processed transiently and <strong>not persisted</strong> after the scan completes.
              </li>
              <li>
                <strong>Bill &amp; split data</strong> — merchant names, amounts, line items, participants, and payment status
                you create or that others share with you.
              </li>
              <li>
                <strong>Onchain data</strong> — bills, debts, and payments submitted to Arc Testnet are written to a public
                blockchain and are inherently visible to anyone.
              </li>
            </ul>
          </section>

          <section className="docs-section">
            <Heading icon={<Eye size={20} />} title="How we use your information" />
            <ul className="docs-list">
              <li>To authenticate you and operate your account.</li>
              <li>To create and operate a wallet so you can view, receive, and settle debts.</li>
              <li>To match you to bills split with you and calculate what you owe or are owed.</li>
              <li>To extract structured data from receipts you upload.</li>
              <li>To maintain the security and integrity of the service.</li>
            </ul>
            <p>
              We do <strong>not</strong> use your data for advertising, profiling, or automated decision-making, and we do not
              build marketing profiles from your sign-in data.
            </p>
          </section>

          <section className="docs-section">
            <Heading icon={<Wallet size={20} />} title="Your wallet" />
            <p>
              On first sign-in we create a <strong>Circle developer-controlled wallet</strong> on Arc Testnet keyed to your
              provider identity (your X or Discord id, or your email address for Google/email sign-in), so you can pay and get
              paid in USDC with no crypto setup. Because this is a testnet demo using{" "}
              <strong>test USDC with no monetary value</strong>, the wallet is operated server-side on your behalf. Sending
              USDC is protected by a wallet PIN that you set. A future mainnet version would offer genuine self-custody for
              real funds.
            </p>
          </section>

          <section className="docs-section">
            <Heading icon={<Share2 size={20} />} title="How we share information" />
            <p>
              We <strong>do not sell, rent, or trade</strong> your personal data, and we do not transfer your sign-in data to
              any third party for their independent use. We share data only with the service providers that run the app — our
              hosting provider, our database provider, the OCR service that processes receipts, our email provider (Resend, for
              email one-time codes), and Circle&apos;s wallet infrastructure — and only to the extent needed to provide those
              functions. Data written to the public blockchain is, by nature, publicly visible.
            </p>
          </section>

          <section className="docs-section">
            <Heading icon={<Trash2 size={20} />} title="Data retention &amp; deletion" />
            <p>
              We retain account and bill data for as long as your account is active. You may request deletion of your account
              and associated sign-in data at any time by emailing{" "}
              <a href="mailto:privacy@splitsy.xyz">privacy@splitsy.xyz</a>. We will delete the data we control, though
              information already written to a public blockchain cannot be removed.
            </p>
          </section>

          {/* ---------------------------------------------------------------- */}
          {/* TERMS */}
          {/* ---------------------------------------------------------------- */}
          <section id="terms" className="docs-section">
            <Heading icon={<FileText size={20} />} title="Terms: acceptance" />
            <p>
              By accessing or using Splitsy (the &quot;Service&quot;), you agree to be bound by these Terms of Service and the
              Privacy Policy above, together with our{" "}
              <Link href="/disclaimer">Disclaimer &amp; acknowledgments</Link>. If you use the Service on behalf of an
              organization, you represent that you have authority to bind that organization.
            </p>
          </section>

          <section className="docs-section">
            <Heading icon={<FlaskConical size={20} />} title="Experimental service — testnet only" />
            <p>
              Splitsy is a prototype for demonstration and educational purposes, operating exclusively on{" "}
              <strong>Arc Testnet</strong>. All balances, payments, and tabs use <strong>test USDC</strong>, which has{" "}
              <strong>no monetary value</strong> and cannot be redeemed for real money. Never send mainnet assets or real funds
              to any address shown in the app. Onchain transactions are irreversible.
            </p>
          </section>

          <section className="docs-section">
            <Heading icon={<UserCheck size={20} />} title="Eligibility &amp; accounts" />
            <p>
              You must be at least the age of majority in your jurisdiction to use the Service. You are responsible for
              activity under your account and for keeping access to your account, wallet, and wallet PIN secure.
            </p>
          </section>

          <section className="docs-section">
            <Heading icon={<KeyRound size={20} />} title="Wallet &amp; PIN" />
            <p>
              A Circle wallet is created for your account to send and receive test USDC on Arc Testnet. You set a wallet PIN
              that is required to send funds; keep it secret. Because the Service is a testnet demo with valueless test USDC,
              the wallet is operated on your behalf and Splitsy is not liable for any test balances.
            </p>
          </section>

          <section className="docs-section">
            <Heading icon={<Ban size={20} />} title="Acceptable use" />
            <p>You agree not to:</p>
            <ul className="docs-list">
              <li>Use the Service for any unlawful, fraudulent, or abusive purpose.</li>
              <li>Attempt to disrupt, overload, reverse-engineer, or gain unauthorized access to the Service.</li>
              <li>Upload content you do not have the right to submit, or that contains others&apos; sensitive data.</li>
              <li>Misrepresent your identity or impersonate another person or entity.</li>
              <li>Use the Service to manage anything of real value or rely on it for production purposes.</li>
            </ul>
          </section>

          <section className="docs-section">
            <Heading icon={<AlertTriangle size={20} />} title="Not financial, legal, or tax advice" />
            <p>
              Nothing in the Service constitutes financial, investment, legal, accounting, or tax advice. The receipt scanner,
              currency conversion, and split calculations are convenience features only. Always review extracted data and
              confirm amounts yourself before acting on them.
            </p>
          </section>

          <section className="docs-section">
            <Heading icon={<ShieldOff size={20} />} title="No warranty" />
            <p>
              The Service is provided <strong>&quot;as is&quot;</strong> and <strong>&quot;as available&quot;</strong> without
              warranties of any kind, express or implied, including merchantability, fitness for a particular purpose, and
              non-infringement. We do not warrant that the Service will be uninterrupted, secure, or error-free, and it may
              change, break, or be taken offline without notice.
            </p>
          </section>

          <section className="docs-section">
            <Heading icon={<Gavel size={20} />} title="Limitation of liability" />
            <p>
              To the maximum extent permitted by law, Splitsy and its contributors will not be liable for any indirect,
              incidental, special, consequential, or exemplary damages, or for any loss arising from your use of the Service,
              including interactions with third-party wallets, networks, bridges, or smart contracts. You use the Service at
              your own risk.
            </p>
          </section>

          <section className="docs-section">
            <Heading icon={<Scale size={20} />} title="Third-party services &amp; no affiliation" />
            <p>
              The Service interoperates with third-party providers (for example, X, Discord, and Google for sign-in, Resend
              for email one-time codes, Circle wallet and blockchain infrastructure, and an OCR provider). Your use of those
              services is governed by their respective terms. Splitsy is an independent project and is{" "}
              <strong>not affiliated with, endorsed by, or sponsored by</strong> X/Twitter, Discord, Google, Circle, Arc, USDC,
              or any other referenced brand. All trademarks belong to their respective owners.
            </p>
          </section>

          <section className="docs-section">
            <Heading icon={<Ban size={20} />} title="Termination" />
            <p>
              We may suspend or terminate access to the Service at any time, with or without notice, including for violation of
              these terms. You may stop using the Service and request deletion of your account at any time.
            </p>
          </section>

          {/* ---------------------------------------------------------------- */}
          {/* SHARED */}
          {/* ---------------------------------------------------------------- */}
          <section className="docs-section">
            <Heading icon={<LockKeyhole size={20} />} title="Security" />
            <p>
              We use reasonable technical and organizational measures to protect your data, including HMAC-signed http-only
              session cookies and a salted hash for your wallet PIN. However, no method of transmission or storage is
              completely secure, and this is experimental software provided &quot;as is&quot;. If you discover a security
              issue, please report it to <a href="mailto:security@splitsy.xyz">security@splitsy.xyz</a>.
            </p>
          </section>

          <section className="docs-section">
            <Heading icon={<RefreshCw size={20} />} title="Changes &amp; contact" />
            <p>
              We may update these terms and this policy from time to time. Material changes will be reflected by updating the
              date below, and continued use of the Service constitutes acceptance. For privacy requests, contact{" "}
              <a href="mailto:privacy@splitsy.xyz">privacy@splitsy.xyz</a>; for anything else,{" "}
              <a href="mailto:support@splitsy.xyz">support@splitsy.xyz</a>. See also our{" "}
              <Link href="/disclaimer">Disclaimer &amp; acknowledgments</Link>.
            </p>
            <p style={{ marginTop: "1.25rem", fontSize: "0.85rem", opacity: 0.7 }}>Last updated: 2026-07-12</p>
          </section>
        </article>
      </div>
    </DocsShell>
  );
}

function Heading({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="docs-heading">
      <span>{icon}</span>
      <h2>{title}</h2>
    </div>
  );
}

function Callout({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <aside className="docs-callout">
      <strong>{title}</strong>
      <p>{children}</p>
    </aside>
  );
}
