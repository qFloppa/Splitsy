import Link from "next/link";
import Image from "next/image";
import DocsShell from "../docs/DocsShell";
import {
  AtSign,
  Database,
  Eye,
  FlaskConical,
  LockKeyhole,
  RefreshCw,
  Share2,
  Trash2,
  Wallet,
} from "lucide-react";

// Render at request time so the nonce-based CSP (see proxy.ts) is applied to
// this page's framework scripts.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Privacy Policy",
  description:
    "How Splitsy collects, uses, and protects your data — including data obtained through Sign in with X — for its experimental bill-splitting demo on Arc Testnet.",
  alternates: { canonical: "/privacy" },
  robots: { index: true, follow: true },
};

export default function PrivacyPage() {
  return (
    <DocsShell>
      <header className="docs-hero">
        <nav className="docs-topbar" aria-label="Privacy navigation">
          <Link href="/" className="docs-brand">
            <span className="logo-crop logo-crop-docs">
              <Image alt="Splitsy" className="logo-crop-image" height={1024} priority src="/splitsy.png" width={1536} />
            </span>
          </Link>
          <div className="docs-toplinks">
            <Link href="/terms">Terms</Link>
            <Link href="/">Open app</Link>
          </div>
        </nav>

        <div className="docs-hero-grid">
          <div>
            <p className="docs-eyebrow">Legal &amp; transparency</p>
            <h1>Privacy Policy.</h1>
            <p className="docs-lede">
              Splitsy is an independent, experimental demo that runs on <strong>Arc Testnet</strong>. This policy
              explains what we collect, why we collect it, and how we handle it — including the limited data we receive
              when you choose <strong>Sign in with X</strong>. We collect as little as possible and never sell your data.
            </p>
          </div>

          <aside className="docs-hero-panel" aria-label="At a glance">
            <div>
              <span>We sell your data?</span>
              <strong>Never</strong>
            </div>
            <div>
              <span>X data used for</span>
              <strong>Sign-in &amp; matching only</strong>
            </div>
            <div>
              <span>Receipts</span>
              <strong>Processed, not stored</strong>
            </div>
            <div>
              <span>Delete anytime</span>
              <strong>Yes — on request</strong>
            </div>
          </aside>
        </div>
      </header>

      <div className="docs-layout">
        <article className="docs-content" style={{ gridColumn: "1 / -1" }}>
          <section className="docs-section">
            <Heading icon={<FlaskConical size={20} />} title="About this policy" />
            <p>
              Splitsy (&quot;we&quot;, &quot;us&quot;) provides a prototype application for scanning receipts, splitting
              shared costs, and settling <strong>test USDC</strong> payments on Arc Testnet. It is offered for
              demonstration and educational purposes only and involves <strong>no real funds</strong>. By using Splitsy
              you agree to this Privacy Policy and to our{" "}
              <Link href="/terms">Terms of Service</Link>. If you do not agree, please do not use the app.
            </p>
          </section>

          <section className="docs-section">
            <Heading icon={<AtSign size={20} />} title="Sign in with X (Twitter)" />
            <p>
              If you choose to sign in with X, we use X&apos;s OAuth 2.0 authentication solely to identify you. We{" "}
              <strong>do not</strong> read your timeline, post on your behalf, send direct messages, or collect any
              tweet, like, follow, or engagement data. On sign-in we make a single request to X&apos;s{" "}
              <code>GET&nbsp;/2/users/me</code> endpoint and receive only:
            </p>
            <ul className="docs-list">
              <li>Your X user ID and username (handle)</li>
              <li>Your display name and profile image URL</li>
              <li>Your confirmed email address (via the <code>users.email</code> scope)</li>
            </ul>
            <p>
              We request read-only scopes (<code>tweet.read</code>, <code>users.read</code>, <code>users.email</code>)
              and use this data only to (1) authenticate you, (2) show your handle and avatar in the app, and (3) match
              you to shared bills that others have split with you by tagging your <strong>@handle</strong>, so you can
              view and settle what you owe.
            </p>
            <Callout title="Revoking access">
              You can revoke Splitsy&apos;s access to your X account at any time from your X account settings under{" "}
              <em>Settings → Security and account access → Apps and sessions → Connected apps</em>.
            </Callout>
          </section>

          <section className="docs-section">
            <Heading icon={<Database size={20} />} title="Information we collect" />
            <ul className="docs-list">
              <li>
                <strong>Account &amp; identity data</strong> — the X sign-in data described above, used to create and
                identify your Splitsy account.
              </li>
              <li>
                <strong>Wallet data</strong> — your public blockchain wallet address, so we can attribute bills, debts,
                and payments to you. We do <strong>not</strong> hold your private keys.
              </li>
              <li>
                <strong>Receipt images</strong> — images you upload are sent to our server only to perform optical
                character recognition (OCR). They are processed transiently and are <strong>not persisted</strong> after
                the scan completes.
              </li>
              <li>
                <strong>Bill &amp; split data</strong> — merchant names, amounts, line items, participants, and payment
                status you create or that others share with you.
              </li>
              <li>
                <strong>Onchain data</strong> — bills, debts, and payments submitted to Arc Testnet are written to a
                public blockchain and are inherently visible to anyone.
              </li>
            </ul>
          </section>

          <section className="docs-section">
            <Heading icon={<Eye size={20} />} title="How we use your information" />
            <ul className="docs-list">
              <li>To authenticate you and operate your account.</li>
              <li>To provision and link a wallet so you can view and settle debts.</li>
              <li>To match you to bills split with you and calculate what you owe or are owed.</li>
              <li>To extract structured data from receipts you upload.</li>
              <li>To maintain the security and integrity of the service.</li>
            </ul>
            <p>
              We do <strong>not</strong> use your data for advertising, profiling, or automated decision-making, and we
              do not build marketing profiles from X data.
            </p>
          </section>

          <section className="docs-section">
            <Heading icon={<Share2 size={20} />} title="How we share information" />
            <p>
              We <strong>do not sell, rent, or trade</strong> your personal data, and we do not transfer X data to any
              third party for their independent use. We share data only with service providers that help us run the app
              — for example, our hosting provider, our database provider, the OCR service that processes receipts, and
              the wallet infrastructure provider that helps provision non-custodial wallets — and only to the extent
              needed to provide those functions. Data written to the public blockchain is, by nature, publicly visible.
            </p>
          </section>

          <section className="docs-section">
            <Heading icon={<Trash2 size={20} />} title="Data retention &amp; deletion" />
            <p>
              We retain account and bill data for as long as your account is active. You may request deletion of your
              account and associated X data at any time by emailing{" "}
              <a href="mailto:privacy@splitsy.xyz">privacy@splitsy.xyz</a>. We will delete the data we control, though
              information already written to a public blockchain cannot be removed.
            </p>
          </section>

          <section className="docs-section">
            <Heading icon={<Wallet size={20} />} title="Blockchain &amp; wallets" />
            <p>
              Splitsy operates on <strong>Arc Testnet</strong> using test USDC that has no monetary value. Wallet
              addresses, amounts, and bill metadata you submit are recorded on a public test blockchain and are visible
              to anyone. Do not include sensitive personal information in bill descriptions or memos.
            </p>
          </section>

          <section className="docs-section">
            <Heading icon={<LockKeyhole size={20} />} title="Security" />
            <p>
              We use reasonable technical and organizational measures to protect your data. However, no method of
              transmission or storage is completely secure, and this is experimental software provided &quot;as is&quot;.
              If you discover a security issue, please report it to{" "}
              <a href="mailto:security@splitsy.xyz">security@splitsy.xyz</a>.
            </p>
          </section>

          <section className="docs-section">
            <Heading icon={<RefreshCw size={20} />} title="Changes &amp; contact" />
            <p>
              We may update this policy from time to time. Material changes will be reflected by updating the date below.
              For any privacy question or request, contact{" "}
              <a href="mailto:privacy@splitsy.xyz">privacy@splitsy.xyz</a>. See also our{" "}
              <Link href="/disclaimer">Disclaimer &amp; acknowledgments</Link> and{" "}
              <Link href="/terms">Terms of Service</Link>.
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

function Callout({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <aside className="docs-callout">
      <strong>{title}</strong>
      <p>{children}</p>
    </aside>
  );
}
