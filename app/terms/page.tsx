import Link from "next/link";
import Image from "next/image";
import DocsShell from "../docs/DocsShell";
import {
  AlertTriangle,
  Ban,
  FileText,
  FlaskConical,
  Gavel,
  RefreshCw,
  ShieldOff,
  UserCheck,
  AtSign,
} from "lucide-react";

// Render at request time so the nonce-based CSP (see proxy.ts) is applied to
// this page's framework scripts.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Terms of Service",
  description:
    "The terms governing use of Splitsy, an experimental bill-splitting demo on Arc Testnet that uses test USDC only and involves no real funds.",
  alternates: { canonical: "/terms" },
  robots: { index: true, follow: true },
};

export default function TermsPage() {
  return (
    <DocsShell>
      <header className="docs-hero">
        <nav className="docs-topbar" aria-label="Terms navigation">
          <Link href="/" className="docs-brand">
            <span className="logo-crop logo-crop-docs">
              <Image alt="Splitsy" className="logo-crop-image" height={1024} priority src="/splitsy.png" width={1536} />
            </span>
          </Link>
          <div className="docs-toplinks">
            <Link href="/privacy">Privacy</Link>
            <Link href="/">Open app</Link>
          </div>
        </nav>

        <div className="docs-hero-grid">
          <div>
            <p className="docs-eyebrow">Legal &amp; transparency</p>
            <h1>Terms of Service.</h1>
            <p className="docs-lede">
              These terms govern your use of Splitsy, an <strong>experimental demo</strong> that runs on{" "}
              <strong>Arc Testnet</strong> with test USDC that has no monetary value. By using the app you agree to
              these terms. If you do not agree, please do not use Splitsy.
            </p>
          </div>

          <aside className="docs-hero-panel" aria-label="At a glance">
            <div>
              <span>Status</span>
              <strong>Experimental demo</strong>
            </div>
            <div>
              <span>Network</span>
              <strong>Arc Testnet</strong>
            </div>
            <div>
              <span>Funds</span>
              <strong>Test USDC — no real value</strong>
            </div>
            <div>
              <span>Warranty</span>
              <strong>None — &quot;as is&quot;</strong>
            </div>
          </aside>
        </div>
      </header>

      <div className="docs-layout">
        <article className="docs-content" style={{ gridColumn: "1 / -1" }}>
          <section className="docs-section">
            <Heading icon={<FileText size={20} />} title="Acceptance of terms" />
            <p>
              By accessing or using Splitsy (the &quot;Service&quot;), you agree to be bound by these Terms of Service and
              by our <Link href="/privacy">Privacy Policy</Link> and{" "}
              <Link href="/disclaimer">Disclaimer</Link>. If you use the Service on behalf of an organization, you
              represent that you have authority to bind that organization.
            </p>
          </section>

          <section className="docs-section">
            <Heading icon={<FlaskConical size={20} />} title="Experimental service — testnet only" />
            <p>
              Splitsy is a prototype provided for demonstration and educational purposes. It operates exclusively on{" "}
              <strong>Arc Testnet</strong>. All balances, payments, and tabs use <strong>test USDC</strong>, which has
              <strong> no monetary value</strong> and cannot be redeemed for real money. Never send mainnet assets or
              real funds to any address shown in the app. Onchain transactions are irreversible.
            </p>
          </section>

          <section className="docs-section">
            <Heading icon={<UserCheck size={20} />} title="Eligibility &amp; accounts" />
            <p>
              You must be at least the age of majority in your jurisdiction to use the Service. You are responsible for
              activity that occurs under your account and for keeping access to your account and wallet secure.
            </p>
          </section>

          <section className="docs-section">
            <Heading icon={<AtSign size={20} />} title="Sign in with X" />
            <p>
              The Service offers authentication via <strong>Sign in with X</strong>. Your use of X&apos;s login is also
              subject to X&apos;s own terms and policies. We access only the limited profile information described in our{" "}
              <Link href="/privacy">Privacy Policy</Link> and use it solely to authenticate you and match you to shared
              bills. You may revoke Splitsy&apos;s access from your X account settings at any time.
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
              <li>Use the Service to manage anything of real value or in reliance on it for production purposes.</li>
            </ul>
          </section>

          <section className="docs-section">
            <Heading icon={<AlertTriangle size={20} />} title="Not financial, legal, or tax advice" />
            <p>
              Nothing in the Service constitutes financial, investment, legal, accounting, or tax advice. The receipt
              scanner, currency conversion, and split calculations are convenience features only. Always review
              extracted data and confirm amounts yourself before acting on them.
            </p>
          </section>

          <section className="docs-section">
            <Heading icon={<ShieldOff size={20} />} title="No warranty" />
            <p>
              The Service is provided <strong>&quot;as is&quot;</strong> and <strong>&quot;as available&quot;</strong>{" "}
              without warranties of any kind, express or implied, including merchantability, fitness for a particular
              purpose, and non-infringement. We do not warrant that the Service will be uninterrupted, secure, or
              error-free, and it may change, break, or be taken offline without notice.
            </p>
          </section>

          <section className="docs-section">
            <Heading icon={<Gavel size={20} />} title="Limitation of liability" />
            <p>
              To the maximum extent permitted by law, Splitsy and its contributors will not be liable for any indirect,
              incidental, special, consequential, or exemplary damages, or for any loss arising from your use of the
              Service, including interactions with third-party wallets, networks, bridges, or smart contracts. You use
              the Service at your own risk.
            </p>
          </section>

          <section className="docs-section">
            <Heading icon={<RefreshCw size={20} />} title="Third-party services" />
            <p>
              The Service interoperates with third-party providers (for example, X for sign-in, wallet and blockchain
              infrastructure, and an OCR provider). Your use of those services is governed by their respective terms.
              Splitsy is an independent project and is not affiliated with, endorsed by, or sponsored by any referenced
              brand or network.
            </p>
          </section>

          <section className="docs-section">
            <Heading icon={<Ban size={20} />} title="Termination" />
            <p>
              We may suspend or terminate access to the Service at any time, with or without notice, including for
              violation of these terms. You may stop using the Service and request deletion of your account at any time.
            </p>
          </section>

          <section className="docs-section">
            <Heading icon={<RefreshCw size={20} />} title="Changes &amp; contact" />
            <p>
              We may update these terms from time to time. Material changes will be reflected by updating the date below,
              and continued use of the Service constitutes acceptance. For questions, contact{" "}
              <a href="mailto:support@splitsy.xyz">support@splitsy.xyz</a>.
            </p>
            <p style={{ marginTop: "1.25rem", fontSize: "0.85rem", opacity: 0.7 }}>Last updated: 2026-07-04</p>
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
