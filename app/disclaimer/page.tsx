import Link from "next/link";
import Image from "next/image";
import DocsShell from "../docs/DocsShell";
import {
  AlertTriangle,
  BadgeCheck,
  FlaskConical,
  Landmark,
  LockKeyhole,
  Scale,
  ShieldCheck,
} from "lucide-react";

// Render at request time so the nonce-based CSP (see proxy.ts) is applied to
// this page's framework scripts.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Disclaimer & acknowledgments",
  description:
    "Splitsy is an experimental demo on Arc Testnet. It uses test USDC only, involves no real funds, is not affiliated with any referenced brand, and is not financial advice.",
  alternates: { canonical: "/disclaimer" },
  robots: { index: true, follow: true },
};

export default function DisclaimerPage() {
  return (
    <DocsShell>
      <header className="docs-hero">
        <nav className="docs-topbar" aria-label="Disclaimer navigation">
          <Link href="/" className="docs-brand">
            <span className="logo-crop logo-crop-docs">
              <Image alt="Splitsy" className="logo-crop-image" height={1024} priority src="/splitsy.png" width={1536} />
            </span>
          </Link>
          <div className="docs-toplinks">
            <Link href="/docs">Docs</Link>
            <Link href="/">Open app</Link>
          </div>
        </nav>

        <div className="docs-hero-grid">
          <div>
            <p className="docs-eyebrow">Legal &amp; transparency</p>
            <h1>Disclaimer &amp; acknowledgments.</h1>
            <p className="docs-lede">
              Splitsy is an independent, experimental demo. It runs on <strong>Arc Testnet</strong> with test USDC that
              has no monetary value, involves <strong>no real funds</strong>, and is not affiliated with any of the
              brands or networks it interoperates with. Please read the points below before using it.
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
              <strong>Test USDC only — no real value</strong>
            </div>
            <div>
              <span>Affiliation</span>
              <strong>Independent project</strong>
            </div>
          </aside>
        </div>
      </header>

      <div className="docs-layout">
        <article className="docs-content" style={{ gridColumn: "1 / -1" }}>
          <section className="docs-section">
            <Heading icon={<FlaskConical size={20} />} title="Experimental software" />
            <p>
              Splitsy is a prototype provided for demonstration and educational purposes. It is offered{" "}
              <strong>&quot;as is&quot;</strong> and <strong>&quot;as available&quot;</strong>, may change, break, or be
              taken offline without notice, and makes no guarantee of availability, accuracy, or fitness for any
              particular purpose. Do not rely on it for production use or for managing anything of value.
            </p>
          </section>

          <section className="docs-section">
            <Heading icon={<AlertTriangle size={20} />} title="Testnet only — no real funds" />
            <p>
              Splitsy operates exclusively on <strong>Arc Testnet</strong>. All balances, payments, and recurring tabs
              use <strong>test USDC</strong>, which has <strong>no monetary value</strong> and cannot be redeemed for
              real money. Never send mainnet assets, real USDC, or real funds to any address shown in this app.
            </p>
            <Callout title="Onchain actions are irreversible">
              Transactions you sign are broadcast to a public test blockchain and cannot be undone. Always review every
              wallet prompt — the amount, the contract, and the network — before approving.
            </Callout>
          </section>

          <section className="docs-section">
            <Heading icon={<Landmark size={20} />} title="No affiliation & trademark acknowledgment" />
            <p>
              Splitsy is an <strong>independent project</strong>. It is <strong>not affiliated with, endorsed by, or
              sponsored by</strong> Circle Internet Financial, Arc, USDC, MetaMask, Google, or any other company,
              protocol, or product referenced in this application or its documentation.
            </p>
            <p>
              All product names, logos, and trademarks are the property of their respective owners. They are referenced
              only to describe interoperability and functionality. Splitsy has <strong>no intent to impersonate, mimic,
              or pass itself off</strong> as any other brand, website, or service. If you are a rights holder and have a
              concern, please contact us at{" "}
              <a href="mailto:support@splitsy.xyz">support@splitsy.xyz</a>.
            </p>
          </section>

          <section className="docs-section">
            <Heading icon={<Scale size={20} />} title="Not financial, legal, or tax advice" />
            <p>
              Nothing in Splitsy constitutes financial, investment, legal, accounting, or tax advice. The receipt
              scanner, currency conversion, and split calculations are convenience features and are not an accounting
              authority. Always review extracted data and confirm amounts yourself before acting on them.
            </p>
          </section>

          <section className="docs-section">
            <Heading icon={<ShieldCheck size={20} />} title="No warranty & limitation of liability" />
            <p>
              To the maximum extent permitted by law, Splitsy and its contributors disclaim all warranties, express or
              implied, and accept no liability for any loss or damage arising from your use of the app, including
              interactions with third-party wallets, networks, bridges, or smart contracts. You use Splitsy at your own
              risk.
            </p>
          </section>

          <section className="docs-section">
            <Heading icon={<LockKeyhole size={20} />} title="Privacy" />
            <ul className="docs-list">
              <li>
                Receipt images you upload are sent to the server only to perform optical character recognition (OCR) and
                are not persisted by the app after processing.
              </li>
              <li>
                Wallet addresses, amounts, and bill metadata you submit are written to a public test blockchain and are
                inherently visible to anyone — do not include sensitive personal information.
              </li>
              <li>Splitsy does not custody funds or hold your private keys; your browser wallet signs every action.</li>
            </ul>
          </section>

          <section className="docs-section">
            <Heading icon={<BadgeCheck size={20} />} title="Security contact" />
            <p>
              If you discover a security issue, please report it to{" "}
              <a href="mailto:security@splitsy.xyz">security@splitsy.xyz</a>. Our machine-readable policy is published at{" "}
              <a href="/.well-known/security.txt">/.well-known/security.txt</a>. For general questions, contact{" "}
              <a href="mailto:support@splitsy.xyz">support@splitsy.xyz</a>.
            </p>
            <p style={{ marginTop: "1.25rem", fontSize: "0.85rem", opacity: 0.7 }}>Last updated: 2026-06-25</p>
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
