import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";

import { Nav } from "@/components/landing/Nav";

import { DocsRail } from "./DocsRail";
import { PARTS, SECTIONS, section } from "./sections";

// The reference document.
//
// Every sentence, table cell, figure and external reference here was on the page
// before; what changed is the chrome around them. The old page carried the four
// things the redesign took out everywhere else — an icon in a circle beside every
// heading, a bordered "at a glance" panel, tinted callout boxes, and a theme
// toggle writing a storage key nothing else reads — plus a fifth the two legal
// documents did not have: a complete parallel palette (--docs-bg, --docs-text,
// --docs-card, --docs-callout-bg and a light/dark pair for each) at the head of
// its own 643-line skin, deciding on one route what dark mode means. It reads
// --pay-poster-fg / --pay-poster-bg / --pay-poster-rule like the rest of the
// site now.
//
// So there are no new components between the vocabulary and the prose. .lp-paper
// is the ground, .bill-poster a section, .bill-section-title a section that names
// itself, .bill-table a table, a.lp-row a ruled row that lights, .lp-step-num a
// position in a sequence, .doc-note a paragraph that raises its voice with a rule
// instead of a box. 37 bordered cards, 40 numbered circles, 16 callouts and 53
// glyphs are re-housed in that and nothing else — the whole lucide import list
// went with them, bar the one arrow on a link that leaves the site.
//
// Structure, numbering and ids all come from ./sections.ts. The contents poster,
// the travelling rail and each section's own head are three renderings of that one
// array, so a section cannot be listed under a number it does not print. Ids are
// unchanged from the previous version: they are what this page is linked to by
// from outside, what its own cross-links point at, and what the search scrolls to.
//
// No scroll-reveal, deliberately — the same call components/LegalDoc.tsx makes,
// for a stronger reason. The search reads section.textContent and wraps hits in
// <mark>; a document shipped at autoAlpha: 0 would be a document whose search
// highlights things you cannot see. The section rules still draw themselves, in
// pure CSS off a view() timeline.

// Render at request time so the nonce-based CSP (see proxy.ts) is applied to
// this page's framework scripts.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Splitsy Docs",
  description: "User and technical documentation for Splitsy bill splitting, recurring payments, Circle Gateway cross-chain payments, and Arc settlement.",
};

/* ── the pieces a section is built from ─────────────────────────────────────── */

type Row = { title: string; body: ReactNode };

/**
 * A section. Reads its own part, ordinal and title out of the outline rather than
 * being handed them, so this file cannot print a heading the index disagrees with.
 *
 * data-title carries the plain title for the search: the heading prints its
 * ordinal inside itself, and scoring off textContent would rank a query for "09"
 * above a query for a subject.
 */
function Section({ children, id }: { children: ReactNode; id: string }) {
  const { n, part, title } = section(id);

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="bill-poster doc-section"
      // The document closes on the footer's 2px rule, so its last section takes
      // the whole gap rather than the half every boundary inside it gets. Derived
      // from the outline so adding a section moves it without an edit here.
      data-last={id === SECTIONS.at(-1)?.id ? "" : undefined}
      data-title={title}
      id={id}
    >
      <div className="bill-poster-head">
        <span className="settle-label">{part}</span>
      </div>
      <h2 className="bill-section-title" id={`${id}-title`}>
        <span className="bill-section-index">{n}</span> {title}
      </h2>
      {children}
    </section>
  );
}

/** A block inside a section. .bill-subhead's arrangement — a label with a rule
 *  running out to the end of the column — without its caps: these are sentences,
 *  and 0.18em of tracking across sixty characters is a line nobody reads. */
function Subhead({ children }: { children: ReactNode }) {
  return (
    <h3 className="bill-subhead doc-subhead">
      <span>{children}</span>
    </h3>
  );
}

/**
 * A set of related points — what 37 bordered cards with icons in tinted squares
 * were actually for: a title and two sentences about it, one of a set.
 *
 * Two columns, each its own list drawing its own top and bottom rule. Not one
 * list flowed across tracks: that leaves a rule hanging with nothing beside it.
 */
function Rows({ rows }: { rows: Row[] }) {
  const half = Math.ceil(rows.length / 2);

  return (
    <div className="doc-rows" data-cols="2">
      {[rows.slice(0, half), rows.slice(half)].map((column, index) =>
        column.length === 0 ? null : (
          // role="list" survives list-style: none, which Safari otherwise takes
          // as permission to drop the list semantics entirely.
          <ul className="lp-rows m-0 list-none p-0" key={index} role="list">
            {column.map((row) => (
              <li className="lp-row doc-row" key={row.title}>
                <span className="doc-row-title">{row.title}</span>
                <p>{row.body}</p>
              </li>
            ))}
          </ul>
        ),
      )}
    </div>
  );
}

/**
 * A sequence. The numeral survives the circle it used to sit in: .lp-step-num is
 * mono, dimmed a register back, "a position in a sequence the eye can skip".
 *
 * Numbered from the array rather than from the data, so inserting a step renumbers
 * the ones after it. `from` exists for the one sequence that opens at 00 — the
 * autopay ceremony's decision step, which happens before the job is created and is
 * numbered to say so.
 */
function Steps({ from = 1, steps }: { from?: number; steps: Row[] }) {
  return (
    <div className="doc-rows">
      <ol className="lp-rows m-0 list-none p-0" role="list">
        {steps.map((step, index) => (
          <li className="lp-row doc-row" key={step.title}>
            <span className="doc-row-title">
              <span className="lp-step-num doc-step-n">{String(index + from).padStart(2, "0")}</span>
              {step.title}
            </span>
            <p>{step.body}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** What was a tinted, bordered callout. A document does not need a box to raise
 *  its voice: the rule above it goes to full ink, which is this system's mark for
 *  a boundary that matters. Same information, one pixel, no panel. */
function Note({ children, title }: { children: ReactNode; title: string }) {
  return (
    <aside className="doc-note">
      <span className="settle-label">{title}</span>
      <p>{children}</p>
    </aside>
  );
}

/** .bill-table, as the app draws it. The left-align and tabular-nums overrides
 *  live in globals.css: that class was written for figures on a receipt, and
 *  fifteen of these hold prose. */
function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="bill-table-wrap">
      <table className="bill-table">
        <thead>
          <tr>
            {head.map((cell) => (
              <th key={cell}>{cell}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The four links out, in a document whose whole subject is that its claims are
 *  checkable. a.lp-row's ruled row that lights, with the arrow leaning on hover. */
const SOURCES = [
  { href: "https://developers.circle.com/gateway", label: "Circle Gateway documentation" },
  { href: "https://developers.circle.com/cctp", label: "Circle CCTP documentation" },
  { href: "https://docs.arc.io/integrate/infrastructure/bridges", label: "Arc bridge infrastructure notes" },
  {
    href: "https://developers.circle.com/gateway/references/supported-blockchains",
    label: "Gateway supported blockchains",
  },
];

function SourceList() {
  return (
    <>
      <Subhead>External references</Subhead>
      <div className="doc-sources">
        <ul className="lp-rows m-0 list-none p-0" role="list">
          {SOURCES.map((source) => (
            <li key={source.href}>
              <a className="lp-row" href={source.href} rel="noopener noreferrer" target="_blank">
                <span>{source.label}</span>
                <ArrowUpRight aria-hidden className="self-center" size={12} />
              </a>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

/* ── the document ───────────────────────────────────────────────────────────── */

export default function DocsPage() {
  return (
    <div className="lp-paper doc-paper">
      <Nav />
      <main id="main">
        {/* ── the head ─────────────────────────────────────────────────────────
            Deliberately not a .bill-poster: it opens the page the way the hero
            does, so it draws no rule above itself and the first rule in the
            document is the one under the head. */}
        <section aria-labelledby="doc-title" className="lp-measure doc-head">
          <p className="settle-label">Product documentation</p>
          <h1 className="lp-display-lg mt-4 max-w-4xl" id="doc-title">
            Everything users need to <span className="lp-headline-accent">understand Splitsy.</span>
          </h1>
          <p className="lp-lede mt-6 max-w-2xl">
            Splitsy turns shared bills into trackable USDC payment flows. It scans receipts, calculates who owes what, records
            debts on Arc Testnet, lets payers fund and pay from their wallets, and automates recurring collection when a cycle
            becomes due.
          </p>

          {/* The four facts a reader wants before the first section. It was a
              bordered panel floated beside the title; it is the app's own
              labelled rail now. A <dl>, because four labelled facts are a
              definition list and the one thing here a screen reader can announce
              as pairs. */}
          <dl className="bill-contents doc-glance">
            {[
              { label: "Primary asset", value: "USDC" },
              { label: "Network", value: "Arc Testnet" },
              { label: "Payment types", value: "One-time bills and recurring tabs" },
              { label: "Cross-chain payment", value: "Circle Gateway (Avalanche, Base, Ethereum → Arc)" },
            ].map((fact) => (
              <div className="bill-cell" key={fact.label}>
                <dt className="settle-label">{fact.label}</dt>
                <dd className="bill-contents-label">{fact.value}</dd>
                <div className="bill-cell-rule" />
              </div>
            ))}
          </dl>
        </section>

        {/* ── the index ────────────────────────────────────────────────────────
            Sixteen sections in four parts, and the only place in the document
            that earns the full 88rem. [data-parts] is the shared rule: how many
            parts a document has is the document's business. */}
        <section aria-labelledby="doc-contents" className="bill-poster" data-parts={PARTS.length}>
          <div className="lp-measure">
            <div className="bill-poster-head">
              <h2 className="settle-label" id="doc-contents">
                Contents
              </h2>
              <span className="bill-poster-fact">
                <b>{SECTIONS.length}</b> sections in <b>{PARTS.length}</b> parts · Arc Testnet · test USDC only
              </span>
            </div>

            <div className="doc-index bill-poster-body">
              {PARTS.map((entry) => (
                <div key={entry.part}>
                  <h3 className="bill-subhead">
                    <span className="settle-label">{entry.part}</span>
                  </h3>
                  <ol className="lp-rows m-0 list-none p-0" role="list">
                    {entry.sections.map((entrySection) => (
                      <li key={entrySection.id}>
                        <a className="lp-row" href={`#${entrySection.id}`}>
                          <span className="doc-index-n">{entrySection.n}</span>
                          <span className="bill-contents-label">{entrySection.title}</span>
                        </a>
                      </li>
                    ))}
                  </ol>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── the document ─────────────────────────────────────────────────────
            A rail and a column. One .lp-measure around both: the sections live in
            the second column, and a .lp-measure inside one would re-apply an 88rem
            cap and a page gutter to a column that already has both. */}
        <div className="lp-measure">
          <div className="doc-layout">
            <DocsRail />

            <article>
              <Section id="overview">
                <p>
                  Splitsy is built for groups that need more than a calculator screenshot. A splitter can upload a receipt, review
                  the extracted bill, assign payer wallets, and create an onchain record of each participant&apos;s share. Payers can
                  connect their wallets later, see only their own debts, pay in full or partially, and bridge USDC into Arc when
                  their balance lives on another supported testnet.
                </p>
                <p>
                  The application has two product surfaces. <strong>Bills</strong> are one-time debts linked to a receipt or expense.{" "}
                  <strong>Recurring</strong> tabs are scheduled payment agreements, such as rent, subscriptions, shared services, or
                  repeating household costs. Both flows are designed around explicit wallet approval and visible balances.
                </p>
                <Rows
                  rows={[
                    {
                      title: "Scan and review",
                      body: (
                        <>
                          Upload a bill image, parse merchant totals and line items, convert non-USD totals to USD, and verify the split
                          before anything is submitted.
                        </>
                      ),
                    },
                    {
                      title: "Wallet-first payment",
                      body: (
                        <>
                          Browser wallets sign contract transactions. The app uses EIP-1193/EIP-6963 provider discovery and Viem wallet
                          clients for Arc Testnet interactions.
                        </>
                      ),
                    },
                    {
                      title: "Pay cross-chain with Gateway",
                      body: (
                        <>
                          Payers with USDC on Avalanche, Base, or Ethereum can pay directly from those chains to Arc Testnet. Gateway burns
                          on the source chain, fetches an attestation, and mints on Arc — all in one two-step flow with no bridge UI.
                        </>
                      ),
                    },
                    {
                      title: "Automated recurring settlement",
                      body: (
                        <>
                          Once a payer has approved a recurring tab, Splitsy checks due cycles automatically so users do not manually press
                          a settlement button every cycle.
                        </>
                      ),
                    },
                    {
                      title: "An agent that pays for you",
                      body: (
                        <>
                          Bills raised against you can be settled by your own funded agent, under ceilings you set. It spends only the USDC
                          you send it, and every settlement is a public on-chain job a second agent has to sign off.
                        </>
                      ),
                    },
                  ]}
                />
              </Section>

              <Section id="using-splitsy">
                <Steps
                  steps={[
                    {
                      title: "Connect or upload",
                      body: (
                        <>
                          Start in the Bills tab. Upload a receipt image or review the default bill fields. The scanner reads totals, tax,
                          tip, line items, and confidence notes.
                        </>
                      ),
                    },
                    {
                      title: "Review the bill",
                      body: (
                        <>
                          Confirm the merchant, currency, subtotal, tax, tip, total, and line items. Non-USD bills are quoted into USD for
                          payment calculations.
                        </>
                      ),
                    },
                    {
                      title: "Choose a split",
                      body: (
                        <>
                          Use equal split for a quick division or manual split when participants owe different amounts. Each payer needs a
                          valid EVM wallet address and a positive amount.
                        </>
                      ),
                    },
                    {
                      title: "Submit the bill",
                      body: (
                        <>
                          The splitter creates a bill in the BillSplitRegistry contract. The contract stores a metadata hash, participant
                          addresses, and each participant&apos;s owed USDC amount.
                        </>
                      ),
                    },
                    {
                      title: "Payers settle",
                      body: (
                        <>
                          Payers connect the matching wallet, approve the registry for the selected USDC amount, and call the payment flow.
                          Payments can be partial as long as they do not exceed the remaining debt.
                        </>
                      ),
                    },
                    {
                      title: "Splitter claims",
                      body: (
                        <>
                          Paid funds accumulate as claimable balance in the registry. The splitter can claim any amount up to the available
                          paid balance.
                        </>
                      ),
                    },
                  ]}
                />
              </Section>

              <Section id="sign-in-and-wallets">
                <p>
                  Splitsy lets you split a bill with anyone by their <strong>handle or email</strong> — even before they have ever
                  opened the app. You sign in with <strong>X, Discord, Google, or a one-time email code</strong>, and each method
                  gives you a ready-to-use USDC wallet on Arc Testnet, so a debtor never has to install a browser wallet, hold a
                  seed phrase, or understand gas to pay what they owe. This section explains exactly what data is used, how the
                  wallet is created, and why Splitsy makes the choices it does.
                </p>

                <Rows
                  rows={[
                    {
                      title: "Four ways to sign in",
                      body: (
                        <>
                          Choose <strong>X</strong>, <strong>Discord</strong>, <strong>Google</strong>, or <strong>email</strong>. X and
                          Discord use OAuth 2.0 and read only your public profile (id, username, name, avatar). Google returns your
                          verified email, name, and picture. Email sends a 6-digit one-time code. No method lets Splitsy post on your
                          behalf or read your messages.
                        </>
                      ),
                    },
                    {
                      title: "Minimal, identify-only access",
                      body: (
                        <>
                          For X the scopes are <code>tweet.read</code>, <code>users.read</code>, <code>offline.access</code>; for Discord,{" "}
                          <code>identify</code> — no write access, no email. Google and email sign-in identify you <strong>by</strong>{" "}
                          your email address. You can revoke an OAuth provider anytime from its connected-apps settings.
                        </>
                      ),
                    },
                    {
                      title: "A real wallet for your identity",
                      body: (
                        <>
                          On first sign-in, Splitsy creates a <strong>Circle developer-controlled wallet</strong> on Arc Testnet keyed to
                          your provider identity. It is a genuine on-chain account with its own address — you can receive USDC to it, send
                          from it, and view it on the block explorer.
                        </>
                      ),
                    },
                    {
                      title: "A PIN before money moves",
                      body: (
                        <>
                          Sending USDC requires a wallet PIN you set yourself. Entering it unlocks sends for five minutes, then re-locks.
                          The PIN is stored only as a salted <code>scrypt</code> hash; the raw PIN never leaves your device in readable form
                          and is never stored.
                        </>
                      ),
                    },
                  ]}
                />

                <Note title="One identity for Google and email">
                  Google sign-in and Email-OTP both resolve to the <strong>same</strong> email-keyed identity (<code>email:&lt;address&gt;</code>),
                  so signing in either way with the same address is one account and one wallet. X and Discord are separate
                  namespaces — an X <code>@alice</code> and a Discord <code>alice</code> are different people.
                </Note>

                <Subhead>How the identity flow works</Subhead>
                <Steps
                  steps={[
                    {
                      title: "Authorize with your provider",
                      body: (
                        <>
                          For X, Discord, and Google you&apos;re redirected to that provider&apos;s consent screen using OAuth 2.0 with PKCE.
                          Splitsy&apos;s server holds the client secret; a signed <code>state</code> value and PKCE code verifier prevent
                          request forgery and code interception. Email sign-in instead emails you a single-use 6-digit code.
                        </>
                      ),
                    },
                    {
                      title: "Read the basic profile once",
                      body: (
                        <>
                          After you approve, Splitsy makes a single call to read your id/handle (or verified email), name, and avatar. No
                          further data is requested from the provider.
                        </>
                      ),
                    },
                    {
                      title: "Create or reuse your wallet",
                      body: (
                        <>
                          Splitsy provisions a Circle wallet keyed to your provider identity (idempotently — the same identity always maps
                          to the same wallet), then stores your handle/email, avatar, and wallet address so friends can tag you.
                        </>
                      ),
                    },
                    {
                      title: "Set a session",
                      body: (
                        <>
                          A signed, http-only session cookie keeps you logged in. It stores only your Splitsy user id — no tokens or profile
                          data are exposed to the browser.
                        </>
                      ),
                    },
                    {
                      title: "Discover what you owe",
                      body: (
                        <>
                          Any bill already tagged to your handle or email is linked to you on sign-in and appears under your unpaid bills,
                          ready to pay from your wallet.
                        </>
                      ),
                    },
                  ]}
                />

                <Subhead>Why a developer-controlled wallet (and not a user-controlled one)</Subhead>
                <p>
                  Circle offers two wallet models. A <strong>user-controlled wallet</strong> is non-custodial but requires the user to
                  authenticate to Circle directly — via Google, Apple, Facebook, email OTP, or a PIN — because the user holds a key
                  share. Some of Splitsy&apos;s sign-in methods (like X and Discord) are <strong>not</strong> supported Circle
                  logins at all, so they cannot unlock a user-controlled wallet; and for the ones that overlap, bridging the two
                  would still force every debtor through a second, unrelated login (and a recovery-phrase burden) just to pay a
                  dinner split — the exact friction Splitsy exists to remove.
                </p>
                <p>
                  A <strong>developer-controlled wallet</strong> is created and operated server-side, keyed to a reference id (your
                  provider identity). That lets Splitsy give <em>anyone</em> a working USDC wallet the instant they sign in — under a
                  single, uniform model across all four providers, with no extra login, no seed phrase, and no app to install.
                  Because Splitsy runs on <strong>Arc Testnet with test USDC that has no monetary value</strong>, the custodial
                  trade-off carries no financial risk while delivering the smoothest possible onboarding. A future mainnet
                  deployment would revisit this and offer genuine self-custody for real funds.
                </p>
                <Table
                  head={["Property", "Developer-controlled (Splitsy today)", "User-controlled"]}
                  rows={[
                    [
                      "Works from a handle/email alone",
                      "Yes — created server-side on sign-in",
                      "Only for Circle-supported logins (not X/Discord)",
                    ],
                    ["Onboarding steps for a newcomer", "None beyond signing in", "Second login plus recovery-phrase setup"],
                    ["Custody", "Server-operated (testnet, valueless USDC)", "User holds a key share"],
                    ["Network", "Arc Testnet (EOA/SCA), USDC transfers", "Arc Testnet"],
                  ]}
                />

                <Subhead>Off-chain ledger for handle-tagged bills</Subhead>
                <p>
                  The <code>BillSplitRegistry</code> contract records debts by wallet address and needs every participant&apos;s address
                  at creation time. A handle or email you tag may belong to someone who has not signed in yet and therefore has no
                  address, so tagged bills are not written to the registry. Instead they live in an <strong>off-chain ledger</strong>:
                  the bill and each debtor&apos;s share are stored keyed by provider + handle/email, and are linked to a real wallet
                  the moment that person signs in. This is a deliberate second mode alongside the on-chain registry, chosen so you
                  can split with anyone without knowing their address.
                </p>
                <Rows
                  rows={[
                    {
                      title: "Direct settlement",
                      body: (
                        <>
                          To pay, your wallet sends USDC <strong>directly to the creditor&apos;s wallet</strong> on Arc — no escrow contract in
                          the middle. Splitsy initiates the transfer, confirms it, and marks the debt paid. Paid bills move to the history
                          at the foot of your Dashboard with an explorer link.
                        </>
                      ),
                    },
                    {
                      title: "Send, receive, and history",
                      body: (
                        <>
                          Your wallet widget shows your live USDC balance, a copyable receive address, a PIN-gated send form, and a
                          transaction history read from Circle — each with a link to the Arc block explorer.
                        </>
                      ),
                    },
                  ]}
                />

                <Note title="What Splitsy stores about you">
                  Only your provider identity (an id/handle, or email for Google/email sign-in), display name, avatar URL, wallet
                  address, and a salted hash of your wallet PIN. No tokens in the browser, and no provider content beyond your basic
                  profile. Everything you can pay or be paid is test USDC on Arc Testnet.
                </Note>
              </Section>

              <Section id="bill-splits">
                <p>
                  The one-time bill flow is anchored by <code>BillSplitRegistry</code>. The registry does not need to know the full
                  receipt body; it stores a hash of bill metadata plus the participant list and amounts. This keeps the contract
                  focused on debt accounting while leaving rich receipt display to the app.
                </p>
                <Table
                  head={["Action", "Contract function", "What happens"]}
                  rows={[
                    [
                      "Create bill",
                      <code key="fn">createBill(bytes32,address[],uint256[])</code>,
                      <>
                        Registers participant debts and emits <code>BillCreated</code>.
                      </>,
                    ],
                    [
                      "Pay debt",
                      <code key="fn">payDebt(uint256,uint256)</code>,
                      "Transfers USDC from payer to the registry and updates paid totals.",
                    ],
                    [
                      "Claim funds",
                      <code key="fn">claim(uint256,uint256)</code>,
                      "Allows only the splitter to withdraw paid, unclaimed funds.",
                    ],
                    [
                      "Look up debts",
                      <>
                        <code>billIdsForParticipant</code>, <code>getParticipant</code>
                      </>,
                      "Loads debts for the connected payer wallet.",
                    ],
                  ]}
                />
                <p>
                  Amounts are represented with 6 decimals to match USDC. User-entered dollar values are converted into USDC base
                  units before they are submitted to the contract.
                </p>
              </Section>

              <Section id="recurring-tabs">
                <p>
                  Recurring tabs are fixed-share payment schedules. A creator chooses a recipient, interval, maximum number of
                  settlement cycles, member wallets, and each member&apos;s fixed USDC share. Members approve the tab contract as a
                  constrained USDC spender. Funds remain in member wallets until settlement runs.
                </p>
                <Rows
                  rows={[
                    {
                      title: "Factory deployment",
                      body: (
                        <>
                          <code>RecurringTabFactory</code> deploys one <code>RecurringTab</code> contract per tab. Each tab has immutable
                          recipient, interval, max cycle count, member list, and fixed shares.
                        </>
                      ),
                    },
                    {
                      title: "Scheduled settlement",
                      body: (
                        <>
                          Splitsy checks factory-created tabs on a schedule and calls <code>settleTab()</code> for tabs that have collectible
                          balances.
                        </>
                      ),
                    },
                    {
                      title: "Shortfall handling",
                      body: (
                        <>
                          If a member has insufficient allowance or balance, the contract emits shortfall events and collects from members
                          who are ready. Late underpaid amounts can be collected later after approval or funding.
                        </>
                      ),
                    },
                    {
                      title: "Claimable balance",
                      body: (
                        <>
                          Settlement increases tab-level <code>claimable</code>. The recipient can call <code>claim()</code> to withdraw
                          collected funds.
                        </>
                      ),
                    },
                  ]}
                />
                <p>
                  The debtor view shows approved amount, wallet balance, paid total, total debt, cycles due, and progress. A paid tab
                  uses a paid-bill stamp. The splitter view shows every member&apos;s share, due amount, remaining
                  total, wallet balance, allowance, and collected total.
                </p>
              </Section>

              <Section id="bill-verification">
                <p>
                  Every on-chain bill carries a verification badge in the payer&apos;s view. It answers{" "}
                  <strong>two different questions</strong>, and the whole design hinges on keeping them separate:
                </p>
                <Rows
                  rows={[
                    {
                      title: "1. Is this a genuine bill?",
                      body: (
                        <>
                          Are the merchant, total, and split shown to you <em>exactly</em> what the creator committed to
                          Arc — with nothing changed since? This is about <strong>authenticity</strong>, and it is proven
                          by cryptography.
                        </>
                      ),
                    },
                    {
                      title: "2. Is the total correct?",
                      body: (
                        <>
                          Does the amount you&apos;re being charged actually match the receipt? This is about{" "}
                          <strong>honesty</strong>, and it is checked by re-reading the receipt image itself.
                        </>
                      ),
                    },
                  ]}
                />
                <Note title="Why “Genuine bill on Arc” and “Total was changed” can both be true">
                  A genuine bill is not the same as a correct one. The blockchain faithfully records whatever the
                  creator committed — so if a creator scans a $3.96 receipt but edits the total to $3.00{" "}
                  <em>before</em> submitting, the chain honestly stores that $3.00 bill. Check 1 confirms the bill is
                  really the creator&apos;s committed record (not tampered with afterward); check 2 catches that the
                  committed total disagrees with the receipt. The alteration happened <strong>at creation</strong>,
                  not after — which is exactly why both statements are true at once.
                </Note>

                <Subhead>What actually goes on-chain</Subhead>
                <p>
                  Storing a full receipt on a blockchain would be expensive and public. Instead, only a{" "}
                  <strong>32-byte fingerprint</strong> is committed. When a bill is created, Splitsy computes a{" "}
                  <code>keccak256</code> hash over the bill&apos;s canonical fields and passes it to{" "}
                  <code>createBill(bytes32 metadataHash, address[] participants, uint256[] amounts)</code>. The
                  contract emits <code>BillCreated</code> with that hash; it can never be edited afterward.
                </p>
                <pre className="doc-code">{`metadataHash = keccak256(
  abi.encode(
    merchant,           // string,   e.g. "ROYAL HANDI HUT"
    currency,           // string,   e.g. "USD"
    cents,              // uint256,  total in cents (e.g. 300 = $3.00)
    labels.join("|"),   // string,   participant labels in order
    receiptHash,        // string,   keccak256 of the receipt image ("" if none)
    dueDate             // uint256,  optional "pay by" Unix seconds — appended
  )                     //           ONLY when the creator set a deadline
)`}</pre>
                <p>
                  The optional <code>dueDate</code> is a strictly additive commitment: a bill with no deadline encodes
                  exactly as bills did before due dates existed, so every previously created bill still verifies
                  byte-for-byte. When present, it anchors the deadline that{" "}
                  <a href="#payment-reputation">payment reputation</a> grades timeliness against — the creator cannot move
                  it after the fact.
                </p>

                <Subhead>All-or-nothing bills</Subhead>
                <p>
                  A bill with a due date can also be created <strong>all or nothing</strong> (
                  <code>escrowUntilFull</code>). On a normal bill each payment is the creator&apos;s the moment it lands —
                  they can claim it straight away. Tick the box and nothing is claimable until{" "}
                  <strong>every</strong> payer has settled. Use it when a partial amount is no good to you: six concert
                  tickets, a group gift, a deposit. $160 does not buy six $40 tickets, and holding four people&apos;s money
                  for a purchase that isn&apos;t happening helps nobody.
                </p>
                <Note title="The deadline does not hand a short bill to its creator">
                  This is the part worth reading twice, because the obvious design is the wrong one. If the bill is still
                  short when the due date passes, it has <strong>failed</strong>: <code>claimable</code> stays 0 forever
                  and each payer calls <code>refund(billId)</code> to take their own contribution back. A deadline that
                  released the pot to the creator instead would let them simply wait it out and keep a partial payment for
                  something that never happened — which is precisely what the payer ticked the box to prevent.
                </Note>
                <p>
                  That is also why an all-or-nothing bill <strong>must</strong> have a due date; the registry rejects the
                  pair at creation otherwise. Without a deadline there is no moment at which a short bill counts as
                  failed, so in a contract with no owner, no pause and no sweep the money could never be released to
                  anyone. With one, every route out is self-service: pay it off and the creator claims, or miss it and the
                  payers withdraw.
                </p>
                <p>
                  A refund puts that payer&apos;s share back on the board rather than killing the bill, so a late payer —
                  or an autopay agent calling <code>payDebtFor</code> — can still complete it afterwards, and the creator
                  can still be paid in full. <code>collectDebt</code> also still unlocks at the deadline on these bills,
                  because pulling from debtors who granted a mandate is exactly what can carry a short bill over the line.
                  Anything pulled that doesn&apos;t is refundable to the debtor it came from, so the mandate cannot be used
                  to extract money from a failed bill.
                </p>
                <p>
                  The human-readable values behind that hash — the <strong>preimage</strong> — are published
                  off-chain to Supabase so a payer&apos;s browser can recompute the hash and compare. The preimage is
                  only a convenience transport: it is <strong>never trusted</strong>. The server that stores it first
                  reads the real <code>metadataHash</code> back from Arc and refuses to save any preimage that
                  doesn&apos;t hash to it, so a stored record is always genuine.
                </p>

                <Subhead>The receipt image is committed too</Subhead>
                <p>
                  To make check 2 possible, the receipt itself is bound to the bill. In the creator&apos;s browser the
                  photo is downscaled and re-encoded to a compact JPEG (~80&nbsp;KB), then hashed with{" "}
                  <code>keccak256</code>. That <code>receiptHash</code> is one of the fields inside{" "}
                  <code>metadataHash</code> above, so the exact image is anchored on-chain. The image bytes themselves
                  are uploaded to a public Supabase Storage bucket keyed by <code>registry/billId</code>. The publish
                  route re-hashes the uploaded bytes and rejects anything that doesn&apos;t match the committed{" "}
                  <code>receiptHash</code>, so the stored image is provably the committed one. Bills typed in by hand
                  have no image and commit <code>receiptHash = &quot;&quot;</code>.
                </p>

                <Subhead>What the payer&apos;s browser does</Subhead>
                <p>
                  Verification runs entirely in the payer&apos;s browser and trusts only the chain — Supabase is just
                  a delivery pipe. The two checks map directly to the two badge lines:
                </p>
                <Steps
                  steps={[
                    {
                      title: "Recompute the fingerprint (authenticity)",
                      body: (
                        <>
                          Fetch the preimage, recompute <code>keccak256</code> over its fields, and compare to the{" "}
                          <code>metadataHash</code> read from Arc. A single altered character — merchant, a cent, a label,
                          or the receipt hash — makes the fingerprints differ. Match ⇒ <em>&quot;Genuine bill on Arc.&quot;</em>{" "}
                          Mismatch ⇒ <em>&quot;Details don&apos;t match Arc — don&apos;t pay.&quot;</em>
                        </>
                      ),
                    },
                    {
                      title: "Re-hash the committed receipt (provenance)",
                      body: (
                        <>
                          Download the receipt image and re-hash its bytes. If the hash doesn&apos;t equal the committed{" "}
                          <code>receiptHash</code>, the image is not the committed one and is neither shown nor trusted. If
                          it matches, the payer is looking at the exact photo anchored on-chain.
                        </>
                      ),
                    },
                    {
                      title: "Re-read the receipt and compare (honesty)",
                      body: (
                        <>
                          The browser independently OCRs that verified image, converting a non-USD total to USD with the
                          same FX endpoint the creator used. It compares the receipt&apos;s own total to the committed
                          total. Because the payer extracts the number themselves from a hash-locked image, a creator who
                          committed a different figure is caught — no trust in the creator required.
                        </>
                      ),
                    },
                  ]}
                />

                <Subhead>What each badge state means</Subhead>
                <Table
                  head={["Badge", "Check 1 — genuine?", "Check 2 — total vs receipt", "What it means for you"]}
                  rows={[
                    [
                      "Verified on Arc",
                      "Match",
                      "Receipt total matches",
                      "Safe to pay: authentic bill and the amount matches the receipt.",
                    ],
                    [
                      "Warning — the total was changed",
                      "Match",
                      "Receipt reads a different amount",
                      "Real bill, but the charged total disagrees with the receipt. Ask the creator first.",
                    ],
                    [
                      "Genuine, no receipt",
                      "Match",
                      "No receipt to check",
                      "Creator typed the total by hand; there is no bill image to cross-check against.",
                    ],
                    [
                      "Genuine, couldn’t re-read",
                      "Match",
                      "OCR/FX unavailable",
                      "Authentic bill; open the receipt and compare the total by eye.",
                    ],
                    [
                      "This bill doesn’t match Arc",
                      "Mismatch",
                      "Not evaluated",
                      <>What you&apos;re shown is not what was committed. Do not pay.</>,
                    ],
                  ]}
                />

                <Note title="Honest limits of the check">
                  Check 2 is a strong signal, not a proof of truth. OCR can misread and exchange rates drift, so a
                  small tolerance (a few cents or ~2%) absorbs noise and only a real gap is flagged — a tiny
                  alteration within tolerance can pass. And nothing stops a creator from committing a fake receipt
                  that matches a fake total; the system proves a bill is authentic and cross-checks it against its own
                  receipt, but it cannot know the receipt is real. To keep the (paid, slow) OCR from re-running on
                  every page load, each result is cached in the browser keyed by the receipt&apos;s content hash, so a
                  reload reuses the same verdict.
                </Note>
              </Section>

              <Section id="payment-reputation">
                <p>
                  Every payer who settles an on-chain bill in full earns <strong>verifiable payment reputation</strong> using
                  the <a href="https://eips.ethereum.org/EIPS/eip-8004">ERC-8004</a> registries Arc pre-deploys on testnet —
                  no Splitsy contract is involved. The payer&apos;s wallet receives an <strong>identity NFT</strong> on the
                  IdentityRegistry, and each completed payment is recorded as a scored feedback entry on the
                  ReputationRegistry. When someone later tags that payer into a new bill, the creation form shows a badge:
                  <em> &quot;Paid N bills in full on Arc · 97/100 timeliness&quot;</em>.
                </p>
                <Table
                  head={["Registry", "Arc Testnet address", "Role"]}
                  rows={[
                    [
                      <code key="r">IdentityRegistry</code>,
                      <code key="a">0x8004A818BFB912233c491871b3d84c89A494BD9e</code>,
                      <>
                        Mints one ERC-721 identity NFT per payer wallet via <code>register(metadataURI)</code>; the tokenId is the payer&apos;s <em>agent id</em>.
                      </>,
                    ],
                    [
                      <code key="r">ReputationRegistry</code>,
                      <code key="a">0x8004B663056A597Dffe9eCcC1965A193B7388713</code>,
                      <>
                        Stores each payment&apos;s score via <code>giveFeedback(agentId, score, …, feedbackHash)</code>.
                      </>,
                    ],
                  ]}
                />

                <Note title="Consent policy — why this can't be used to grief anyone">
                  Feedback is <strong>positive-only</strong> and recorded <strong>only for a payment the wallet itself
                  made</strong> — paying is the consent. A debt someone merely tags you into can never touch your score, so
                  fake bills can&apos;t harm a reputation. An empty profile means &quot;new here&quot;, and the badge always
                  renders it as neutral (&quot;No payment history yet&quot;), never as bad.
                </Note>

                <Subhead>How a score is earned</Subhead>
                <Steps
                  steps={[
                    {
                      title: "A payment settles on-chain",
                      body: (
                        <>
                          The anchor is always a <code>BillSplitRegistry.DebtPaid</code> event (or a recurring{" "}
                          <code>settleTab</code> collection). Only payments that complete the payer&apos;s full share
                          (<code>paidTotal ≥ owedTotal</code>) are scored.
                        </>
                      ),
                    },
                    {
                      title: "The payer gets an identity NFT (first payment only)",
                      body: (
                        <>
                          Registration is lazy: on the wallet&apos;s first scored payment, <code>register()</code> mints its
                          identity NFT. A Circle-wallet payer&apos;s own wallet signs (it just paid, so it holds gas); for
                          browser-wallet payers a dedicated <strong>registrar</strong> wallet mints on their behalf, then
                          transfers the NFT to the payer — every payer ends up owning their own identity.
                        </>
                      ),
                    },
                    {
                      title: "Timeliness is graded against the committed due date",
                      body: (
                        <>
                          The score compares the <code>payDebt</code> <em>block timestamp</em> (never a server clock) to the{" "}
                          <code>dueDate</code> the creator committed into the bill&apos;s metadata hash — a deadline that cannot be
                          moved after creation.
                        </>
                      ),
                    },
                    {
                      title: "A validator wallet records the feedback",
                      body: (
                        <>
                          A dedicated Splitsy <strong>validator</strong> wallet calls <code>giveFeedback</code> with the score, a
                          timing tag, and a <code>feedbackHash</code> binding the entry to the exact payment transaction it scores.
                        </>
                      ),
                    },
                  ]}
                />

                <Subhead>The scoring curve</Subhead>
                <Table
                  head={["Situation", "Tag", "Score"]}
                  rows={[
                    ["Bill had no due date", <code key="t">paid_in_full</code>, "100"],
                    ["Paid by the due date + 2-day grace window", <code key="t">paid_on_time</code>, "100"],
                    ["Paid after the grace window", <code key="t">paid_late</code>, "100 − 5 per whole day late, floored at 50"],
                  ]}
                />
                <p>
                  Paying is always positive — even a very late payment is evidence of good faith, so the floor is a passing
                  50, and a payment that is never made simply records nothing. The badge&apos;s aggregate is an{" "}
                  <strong>amount-weighted average</strong>: each payment is weighted by the payer&apos;s USDC share, so a
                  large bill paid late drags the average more than a small one. Weighting happens only at aggregation; every
                  on-chain score stays simple and independently verifiable. Recurring tabs score too: each settled cycle a
                  member is collected from earns one independent score, graded against that cycle&apos;s boundary.
                </p>

                <Subhead>Three wallets, by design</Subhead>
                <p>
                  ERC-8004 forbids an agent&apos;s owner from scoring its own agent, so Splitsy separates roles across three
                  distinct wallets:
                </p>
                <Table
                  head={["Wallet", "Who it is", "What it does"]}
                  rows={[
                    [
                      "Payer",
                      "The wallet that paid the bill",
                      "Owns (or is bound to) the identity NFT being scored. Circle-wallet payers sign their own registration.",
                    ],
                    [
                      "Registrar",
                      "Dedicated Splitsy Circle wallet",
                      "Mints identity NFTs for browser-wallet payers, who never hand Splitsy a wallet to sign with, then transfers each NFT to its payer. It holds those NFTs at mint time — which is exactly why it must not also score them.",
                    ],
                    [
                      "Validator",
                      "A second dedicated Splitsy Circle wallet",
                      <>
                        Records every <code>giveFeedback</code>. Distinct from the registrar and from all payer wallets, so the no-self-scoring rule always holds.
                      </>,
                    ],
                  ]}
                />

                <Subhead>Verify a score yourself</Subhead>
                <p>
                  Every feedback entry commits{" "}
                  <code>feedbackHash = keccak256(&quot;splitsy:bill:&lt;billId&gt;:&lt;payTxHash&gt;&quot;)</code> (recurring
                  cycles use <code>splitsy:tab:&lt;tabId&gt;:cycle:&lt;n&gt;:&lt;settleTxHash&gt;</code>), and its{" "}
                  <code>fileuri</code> field carries the same payment hash as <code>tx:&lt;payTxHash&gt;</code>. That makes
                  each score independently re-checkable against the payment it claims to describe, with nothing but a block
                  explorer:
                </p>
                <Steps
                  steps={[
                    {
                      title: "Find the feedback entry",
                      body: (
                        <>
                          On <a href="https://testnet.arcscan.app">Arcscan</a>, open the ReputationRegistry address above and
                          locate the <code>giveFeedback</code> transaction (the badge&apos;s data mirrors <code>feedback_tx</code>
                          per entry). Read the decoded inputs: agent id, score, timing tag, bill tag, and <code>feedbackHash</code>.
                        </>
                      ),
                    },
                    {
                      title: "Recompute the hash",
                      body: (
                        <>
                          Compute <code>keccak256</code> of the UTF-8 string{" "}
                          <code>splitsy:bill:&lt;billId&gt;:&lt;payTxHash&gt;</code> using the bill id from the tag and the payment
                          hash from <code>fileuri</code>. It must equal the committed <code>feedbackHash</code> — one changed
                          character breaks it.
                        </>
                      ),
                    },
                    {
                      title: "Check the payment is real and complete",
                      body: (
                        <>
                          Open the payment transaction on Arcscan and confirm it emitted{" "}
                          <code>DebtPaid</code> from the BillSplitRegistry with the same bill id, with the scored wallet as payer,
                          and with <code>paidTotal ≥ owedTotal</code>.
                        </>
                      ),
                    },
                    {
                      title: "Check the deadline it was graded against",
                      body: (
                        <>
                          Fetch the bill&apos;s published preimage (see <a href="#bill-verification">Bill Verification</a>) and
                          recompute the metadata hash — the committed <code>dueDate</code> inside it is the deadline the timing
                          score used, and the payment&apos;s block timestamp is the &quot;paid at&quot; moment. Apply the curve
                          above and you reproduce the exact score.
                        </>
                      ),
                    },
                    {
                      title: "Check the identity binding",
                      body: (
                        <>
                          On the IdentityRegistry, confirm the agent id from step 1 is the token minted in the payer&apos;s
                          registration transaction — the mint&apos;s <code>Transfer</code> log carries the tokenId.
                        </>
                      ),
                    },
                  ]}
                />

                <Note title="Regenerating reputation from chain data">
                  Splitsy mirrors feedback rows in its database purely for fast display (Arc&apos;s <code>eth_getLogs</code>{" "}
                  is range-capped, so history can&apos;t be re-scanned per page load) — <strong>the chain remains the audit
                  trail</strong>. If the mirror is lost or a payment was missed, an operator replays history through the same
                  scoring path with <code>scripts/circle-scp-replay.ts</code>: it pulls the stored <code>DebtPaid</code>{" "}
                  events, decodes each, and re-runs scoring. The path is idempotent per (payer, bill) — and the
                  on-chain registry rejects nothing twice differently — so replaying never double-counts, and every
                  regenerated row is re-verifiable by the steps above.
                </Note>

                <Subhead>What the badge shows — and what it never does</Subhead>
                <ul>
                  <li>The badge appears while tagging payers into a new bill, looked up by handle, email, or address.</li>
                  <li>It shows the count of bills paid in full, the amount-weighted timeliness average, and how many were late.</li>
                  <li>Looking up a handle never reveals the wallet address behind it — the API returns only the aggregate.</li>
                  <li>Looking up a handle never creates a wallet; wallets are only provisioned when a bill is actually created.</li>
                  <li>&quot;No payment history yet&quot; covers both &quot;person unknown&quot; and &quot;wallet known, no payments&quot; — deliberately indistinguishable.</li>
                </ul>
                <p>
                  Optionally, each identity NFT&apos;s <code>metadataURI</code> points to an agent profile pinned to IPFS
                  (name, agent type, wallet). Without IPFS configured, registration falls back to an inline{" "}
                  <code>data:</code> URI — the reputation mechanics are identical either way.
                </p>
              </Section>

              <Section id="circle-and-arc">
                <p>
                  Splitsy uses Circle and Arc technology for USDC movement and settlement. Arc Testnet is the destination network for
                  the app&apos;s contracts. Circle Gateway enables cross-chain USDC payments from any supported source chain
                  directly to Arc Testnet in one flow.
                </p>
                <Rows
                  rows={[
                    {
                      title: "Circle Gateway",
                      body: (
                        <>
                          Pay from <strong>any supported testnet</strong> (Avalanche Fuji, Base Sepolia, Ethereum Sepolia) and settle on Arc.
                          Two-step flow: sign an EIP-712 burn intent on the source chain (gas-free), then execute the mint transaction on Arc.
                          No bridge UI, no waiting — native USDC moves chain-to-chain in seconds.
                        </>
                      ),
                    },
                    {
                      title: "CCTP",
                      body: (
                        <>
                          Circle&apos;s Cross-Chain Transfer Protocol burns USDC on the source chain and mints it on the destination chain.
                          Gateway wraps CCTP with a permissionless API that returns an attestation, so the payer&apos;s wallet can execute
                          the mint directly without holding for manual attestation fetching.
                        </>
                      ),
                    },
                    {
                      title: "Browser wallets",
                      body: (
                        <>
                          Splitsy discovers wallets with EIP-6963 announcements, requests accounts through EIP-1193, prefers MetaMask when
                          available, and uses the wallet provider for signing. Gateway payment requires the wallet to switch chains twice:
                          once to sign the burn intent on the source chain, once to execute the mint on Arc.
                        </>
                      ),
                    },
                    {
                      title: "Arc properties",
                      body: (
                        <>
                          Arc is EVM-compatible, uses USDC as its gas token in the Arc environment, and supports CCTP-based USDC bridging.
                          Gateway&apos;s GatewayMinter contract on Arc (<code>0x0022222A...</code>) handles the final mint step after attestation.
                        </>
                      ),
                    },
                  ]}
                />
                <SourceList />
              </Section>

              <Section id="autopay-agents">
                <p>
                  When someone raises a bill against you, you can have it settled without opening the app. The thing that
                  settles it is <strong>your own agent</strong>: a wallet on Arc that belongs to your Splitsy account, holds
                  its own USDC balance, carries its own{" "}
                  <a href="https://eips.ethereum.org/EIPS/eip-8004">ERC-8004</a> identity NFT, and spends strictly under
                  ceilings you set. It draws only on what you have sent it — Splitsy takes no allowance on your own wallet
                  to make this work.
                </p>
                <Note title="You must fund your agent before anything settles">
                  This is the one step nobody can do for you. Your agent pays your share, escrows the job fee, and pays its
                  own gas (Arc charges gas in USDC) — all out of a balance you send it. Until it holds USDC, every bill is
                  skipped with <code>agent_unfunded</code> and nothing is created on chain. A suggested first top-up is{" "}
                  <strong>2 USDC</strong>; send more if the shares you expect are larger.
                </Note>

                <Rows
                  rows={[
                    {
                      title: "One agent per account",
                      body: (
                        <>
                          Its wallet is keyed to your account, not to a wallet, so the <em>same</em> agent and the same balance
                          cover both your Splitsy wallet and any browser wallet you have linked. You fund it once.
                        </>
                      ),
                    },
                    {
                      title: "Its balance is the hard ceiling",
                      body: (
                        <>
                          Funding is a plain USDC transfer to the agent — custody, not permission. An agent holding 5 USDC can
                          never spend 6, whatever any rule or bug says, because it has nothing else to draw on.
                        </>
                      ),
                    },
                    {
                      title: "Rules are checked before it spends",
                      body: (
                        <>
                          Per-bill ceiling, per-day ceiling, an allowed-creator list, a creator score floor, a verified-hash
                          requirement, and a bill-contents review. Every one is a ceiling evaluated before payment, never a target.
                        </>
                      ),
                    },
                    {
                      title: "Every settlement is an audited job",
                      body: (
                        <>
                          The payment is wrapped in an <a href="https://eips.ethereum.org/EIPS/eip-8183">ERC-8183</a> job:
                          your agent posts and escrows a fee, a Splitsy agent does the work, and a <em>third</em> agent is paid to
                          check the debt really settled before that fee is released.
                        </>
                      ),
                    },
                  ]}
                />

                <Subhead>Funding your agent</Subhead>
                <p>
                  The <strong>Fund</strong> button sits next to the agent&apos;s balance on the settlement-agents panel.
                  Whichever route you use, it is an ordinary inbound USDC transfer on Arc Testnet — there is no special
                  deposit contract, and you can verify the balance yourself on{" "}
                  <a href="https://testnet.arcscan.app">Arcscan</a>.
                </p>
                <Table
                  head={["Route", "What happens", "What it needs"]}
                  rows={[
                    [
                      "From a connected browser wallet",
                      <>
                        Your wallet signs a USDC <code>transfer</code> to the agent&apos;s address. Splitsy waits for the receipt and checks it succeeded.
                      </>,
                      "A wallet connected on Arc Testnet with USDC.",
                    ],
                    [
                      "From your Splitsy wallet",
                      "The same transfer, sent server-side from your Circle wallet.",
                      "Your wallet PIN unlocked — the same five-minute unlock a normal send uses.",
                    ],
                    [
                      "From anywhere else",
                      "Send USDC to the agent’s address from any wallet or faucet. Nothing in the app needs to know.",
                      "Just the address, shown on the card and linked to the explorer.",
                    ],
                  ]}
                />
                <p>
                  Three things come out of that one balance on every settlement: <strong>your share</strong> of the bill,
                  the <strong>job fee</strong> (0.01 USDC by default, escrowed and released to the agent that did the work),
                  and the agent&apos;s own <strong>gas</strong>. Before it starts, the agent checks it holds the fee plus a{" "}
                  <strong>0.20 USDC</strong> gas headroom plus the share itself; short of that it skips with{" "}
                  <code>agent_unfunded</code> and opens no job, so an underfunded agent costs you nothing. Top it up and the
                  next bill settles.
                </p>

                <Note title="Two logins can mean two agents — and only one of them is funded">
                  Signing in with a browser wallet creates an account of its own. If you used a wallet here before adding a
                  social login, you have two accounts, and therefore two agents with two separate balances and two separate
                  rule sets — neither can spend the other&apos;s. The panel deliberately shows <strong>both</strong>, because
                  a hidden one is how USDC ends up in an agent you cannot find. <strong>Link wallet</strong> merges them into
                  the account that was already funded; <strong>Unlink</strong> hands the agent and its balance back.
                </Note>

                <Subhead>Three agents on every job</Subhead>
                <p>
                  The settlement itself is not a single hidden server call. It is an ERC-8183 job on the already-deployed{" "}
                  <code>AgenticCommerce</code> contract on Arc Testnet, with three <strong>distinct</strong> wallets in three
                  roles, so no agent ever grades its own work:
                </p>
                <Table
                  head={["Role", "Who", "What it does"]}
                  rows={[
                    ["Client", <strong key="w">Your agent</strong>, "Posts the job and escrows the fee out of your balance."],
                    [
                      "Provider",
                      <>
                        The <strong>Splitsy Settler</strong>
                      </>,
                      "Prices the work, buys the bill review, settles the debt, and submits proof of what it did.",
                    ],
                    [
                      "Evaluator",
                      <>
                        The <strong>Splitsy Auditor</strong>
                      </>,
                      "Reads the registry on chain and releases the escrow only if the debt really is settled.",
                    ],
                  ]}
                />
                <Steps
                  from={0}
                  steps={[
                    {
                      title: "Decide — and buy a second opinion",
                      body: (
                        <>
                          Your rules run first against the bill. If they say pay and the contents check is on, the Settler{" "}
                          <em>buys</em> a review of the bill from the Auditor over x402. Any refusal stops here:{" "}
                          <strong>no job is created and no transaction is sent</strong>, so a skip costs nothing.
                        </>
                      ),
                    },
                    {
                      title: "createJob — your agent",
                      body: (
                        <>
                          Your agent opens the job naming the Settler as provider, the Auditor as evaluator, a description
                          identifying the bill and debtor, and an expiry one hour out.
                        </>
                      ),
                    },
                    {
                      title: "setBudget — the Settler",
                      body: (
                        <>
                          The provider prices its own work at the settlement fee. The client does not set the provider&apos;s price.
                        </>
                      ),
                    },
                    {
                      title: "fund — your agent",
                      body: (
                        <>
                          The fee moves from your agent&apos;s balance into escrow. The <strong>bill money is never in the
                          escrow</strong> — only the fee.
                        </>
                      ),
                    },
                    {
                      title: "settle — the debt is paid",
                      body: (
                        <>
                          <code>BillSplitRegistry.payDebtFor(billId, debtor, amount)</code> is called by your agent, paying your
                          share out of its own balance. This is the only step that moves bill money.
                        </>
                      ),
                    },
                    {
                      title: "submit — the Settler",
                      body: (
                        <>
                          The Settler submits <code>keccak256(settlementTxHash)</code> as the deliverable, so anyone holding the
                          settlement transaction can recompute it and check the job against it.
                        </>
                      ),
                    },
                    {
                      title: "complete — the Auditor",
                      body: (
                        <>
                          The Auditor calls <code>getParticipant</code> on the registry itself and completes the job only when{" "}
                          <code>paid ≥ owed</code>. Otherwise it does not complete, the job expires, and the Settler is not paid.
                        </>
                      ),
                    },
                  ]}
                />
                <Note title="The audit step is the point, not decoration">
                  An evaluator that rubber-stamped would make the escrow meaningless. This one re-reads the chain rather
                  than trusting the Settler&apos;s claim, and it is a different wallet from both the client and the provider,
                  so the party that gets paid is never the party that decides it earned it.
                </Note>

                <Subhead>The bill review is bought, not asked for</Subhead>
                <p>
                  &quot;Check the bill&apos;s contents before paying&quot; is not a free internal function call. The Auditor{" "}
                  <strong>sells</strong> that verdict at <strong>$0.002</strong> per review and the Settler buys it over{" "}
                  <strong>x402</strong> — the same HTTP <code>402 Payment Required</code> protocol Scout uses — paying out of
                  the fee income it earns from completed jobs. The review weighs the merchant, total and your share against
                  each other; it is given headline figures only and never the receipt image, so it cannot tell who ordered
                  what.
                </p>
                <p>
                  Every failure direction is a refusal: a 402, a timeout, an unparseable verdict, a missing key, or a failed
                  x402 settlement. <strong>A Settler that cannot buy a review settles nothing.</strong>
                </p>

                <Subhead>Splitsy&apos;s paid endpoints</Subhead>
                <Table
                  head={["Endpoint", "Price", "Seller", "Buyer"]}
                  rows={[
                    [<code key="e">/api/ocr</code>, "$0.005 USDC", "Splitsy", "Scout, per receipt scan"],
                    [<code key="e">/api/fx</code>, "$0.001 USDC", "Splitsy", "Scout, only for non-USD receipts"],
                    [
                      <code key="e">/api/agents/review</code>,
                      "$0.002 USDC",
                      "The Splitsy Auditor",
                      "The Splitsy Settler, before every settlement",
                    ],
                  ]}
                />
                <p>
                  All three are open to anyone who pays — that is what makes them a market rather than an internal call. Each
                  is settled by Circle&apos;s batch facilitator against an offchain{" "}
                  <strong>EIP-3009</strong> authorization, so the buying agent spends <strong>no gas</strong> to pay, and
                  both sides of every payment are recorded in Splitsy&apos;s x402 ledger.
                </p>

                <Note title="Your reputation, not your agent's">
                  <code>payDebtFor</code> pulls from the agent but credits <strong>you</strong>, and the{" "}
                  <code>DebtPaid</code> event names <strong>you</strong> as payer. So a bill your agent settles earns{" "}
                  <a href="#payment-reputation">payment reputation</a> for your wallet exactly as if you had paid it by
                  hand — the agent accumulates none of its own.
                </Note>

                <Subhead>Reading the decision log</Subhead>
                <p>
                  Every bill your agent looked at leaves a row, including the ones it refused — the refusals are the point,
                  because they are what shows a spending permission is still constrained. Each row carries the bill, the
                  amount, the decision, and a reason:
                </p>
                <Table
                  head={["Reason", "What happened"]}
                  rows={[
                    [
                      <code key="r">agent_unfunded</code>,
                      <>
                        The balance could not cover the share plus the fee plus gas headroom. <strong>No job was created.</strong> Top it up.
                      </>,
                    ],
                    [
                      <>
                        <code>over_bill_cap</code> / <code>over_daily_cap</code>
                      </>,
                      "Above your per-bill or per-day ceiling.",
                    ],
                    [
                      <>
                        <code>untrusted_creator</code> / <code>low_creator_score</code>
                      </>,
                      "The creator is not on your allowed list, or their payment reputation is below your floor.",
                    ],
                    [
                      <>
                        <code>hash_mismatch</code> / <code>unverifiable</code>
                      </>,
                      <>
                        The bill&apos;s details do not match what was committed on chain, or nothing was published to check against.
                      </>,
                    ],
                    [
                      <code key="r">review_unavailable</code>,
                      "The paid review refused or could not be read. Fail-closed: nothing was paid.",
                    ],
                    [
                      <>
                        <code>job_failed</code> / <code>tx_failed</code>
                      </>,
                      "A job transaction reverted, or the settlement transaction itself failed.",
                    ],
                    [
                      <>
                        <code>nothing_owed</code> / <code>disabled</code>
                      </>,
                      "The share was already settled, or autopay is switched off.",
                    ],
                  ]}
                />
                <p>
                  A settled row expands into its <strong>job trail</strong>: every transaction of the ceremony with its block
                  number and hash, the job&apos;s live status read from the contract, and the x402 payments that gated it,
                  each linking to Circle&apos;s own receipt. The status stored on the row is a display mirror; the contract is
                  the source of truth.
                </p>
                <Table
                  head={["Job status", "Means"]}
                  rows={[
                    [<code key="s">completed</code>, "The full ceremony ran; the Auditor verified the debt and released the escrow."],
                    [
                      <code key="s">settled_incomplete</code>,
                      <>
                        <strong>Your debt is paid.</strong> Only the submit or complete step broke afterwards.
                      </>,
                    ],
                    [
                      <code key="s">settlement_unconfirmed</code>,
                      "The settlement was broadcast but not confirmed in time; it may still mine.",
                    ],
                    [<code key="s">failed</code>, "The ceremony broke before the payment step. No money moved and none can."],
                  ]}
                />
                <p>
                  The last three are deliberately logged as a <strong>payment for the full amount</strong> whenever the money
                  might have moved, and they count against your daily ceiling. Costing you headroom you were entitled to is
                  recoverable; handing back a cap you had already spent is not.
                </p>

                <Subhead>What it costs to run</Subhead>
                <Rows
                  rows={[
                    {
                      title: "Six transactions per settled share",
                      body: (
                        <>
                          Not per bill — per share. A four-person bill where everyone autopays is four independent jobs. A{" "}
                          <strong>skip costs zero</strong>, because the decision happens before the job is opened.
                        </>
                      ),
                    },
                    {
                      title: "0.01 USDC fee, at risk of nothing else",
                      body: (
                        <>
                          The escrow only ever holds the fee. If a settlement fails the job simply expires an hour later, and at
                          worst that fee is stranded — the bill money is never inside the escrow in the first place.
                        </>
                      ),
                    },
                  ]}
                />
                <p>
                  Two USDC approvals sit outside those six. They are lazy — sent only when the current allowance is short,
                  and for 100× the amount being spent — so they amortise across roughly a hundred settlements instead of
                  landing on each one.
                </p>
              </Section>

              <Section id="scout-agent">
                <p>
                  When you upload a receipt, Splitsy does not scan it directly. The upload is handed to{" "}
                  <strong>Scout</strong> — an autonomous agent with <strong>its own wallet</strong>, its own{" "}
                  <a href="https://eips.ethereum.org/EIPS/eip-8004">ERC-8004</a> on-chain identity, and a daily
                  spending budget. Scout decides whether your photo is worth scanning, then <strong>pays
                  Splitsy&apos;s own scanning API in USDC</strong>, per call, over Arc. If the first read looks
                  shaky it buys a second opinion out of its own budget.
                </p>
                <p>
                  This is a real machine-to-machine economy, not a metaphor: every scan is an HTTP request that
                  gets answered with <code>402 Payment Required</code>, a USDC payment authorization, and only
                  then the parsed bill. You never pay for it and never see a prompt — the agent&apos;s spending is
                  its own.
                </p>

                <Rows
                  rows={[
                    {
                      title: "It judges before it spends",
                      body: (
                        <>
                          Scout checks the photo first. Under <strong>8&nbsp;KB</strong>, or under{" "}
                          <strong>200&nbsp;px</strong> on either edge, and it refuses to pay at all — you get asked for
                          a clearer picture instead. Nothing is spent on an unreadable image.
                        </>
                      ),
                    },
                    {
                      title: "It pays per call over HTTP",
                      body: (
                        <>
                          Splitsy&apos;s <code>/api/ocr</code> and <code>/api/fx</code> are paywalled with the{" "}
                          <strong>x402</strong> protocol. Scout signs an offchain <strong>EIP-3009</strong>{" "}
                          authorization instead of sending a transaction — so it pays for the API and burns{" "}
                          <strong>no gas</strong> doing it.
                        </>
                      ),
                    },
                    {
                      title: "It buys a second opinion",
                      body: (
                        <>
                          Each parse carries a confidence score. Below <strong>0.80</strong>, and with budget left,
                          Scout pays a second time for a stricter re-read, then keeps whichever parse scored higher.
                        </>
                      ),
                    },
                    {
                      title: "It has a hard budget",
                      body: (
                        <>
                          A daily cap (default <strong>$1.00</strong> USDC) is the agent&apos;s risk control. When the
                          cap is reached Scout stops paying and returns its best-effort read, flagged as low
                          confidence — it can never overspend.
                        </>
                      ),
                    },
                  ]}
                />

                <Note title="Why this is only possible on Arc">
                  A $0.005 payment is absurd on most chains — the gas would cost hundreds of times the payment
                  itself. Arc settles in <strong>sub-second finality</strong> with{" "}
                  <strong>USDC-denominated gas of roughly a cent</strong>, and Circle&apos;s Gateway batches many
                  authorizations into one settlement so gas is paid once per batch rather than once per payment.
                  That is what makes a half-cent API call worth charging for at all.
                </Note>

                <Subhead>What a single scan actually does</Subhead>
                <Steps
                  steps={[
                    {
                      title: "Assess the image — no spend yet",
                      body: (
                        <>
                          Scout reads the file size and pixel dimensions. Too small or too low-resolution and it
                          declines with a reason, having paid nothing.
                        </>
                      ),
                    },
                    {
                      title: "Request the scanner, get a 402",
                      body: (
                        <>
                          Scout calls <code>/api/ocr</code>. The endpoint answers{" "}
                          <code>402 Payment Required</code> with a <code>PAYMENT-REQUIRED</code> header quoting the
                          terms: scheme <code>exact</code>, network <code>eip155:5042002</code> (Arc Testnet), the USDC
                          asset, and the amount in atomic units (<code>5000</code> = $0.005).
                        </>
                      ),
                    },
                    {
                      title: "Sign an authorization, not a transaction",
                      body: (
                        <>
                          Scout signs an offchain EIP-3009 authorization from its wallet and retries the same request
                          with a <code>payment-signature</code> header. No transaction is broadcast at this point, so
                          the agent spends no gas.
                        </>
                      ),
                    },
                    {
                      title: "Circle verifies and settles",
                      body: (
                        <>
                          Splitsy&apos;s server hands the authorization to Circle&apos;s batch facilitator, which
                          verifies it and settles the USDC. Only then does the endpoint run the scan and return the
                          parsed bill, with a <code>PAYMENT-RESPONSE</code> header carrying the settlement reference.
                        </>
                      ),
                    },
                    {
                      title: "Check confidence, maybe pay again",
                      body: (
                        <>
                          If confidence is under 0.80 and the daily cap allows it, Scout repeats the paid call with a
                          stricter re-read instruction and keeps the better of the two parses.
                        </>
                      ),
                    },
                    {
                      title: "Convert the currency if needed",
                      body: (
                        <>
                          If the receipt is not in USD, Scout pays <code>/api/fx</code> ($0.001) for a rate to quote
                          the total in USD — the same figure your split is calculated from.
                        </>
                      ),
                    },
                  ]}
                />

                <Subhead>What Scout charges itself</Subhead>
                <Table
                  head={["Paid endpoint", "Price per call", "When Scout calls it"]}
                  rows={[
                    [
                      <code key="e">/api/ocr</code>,
                      "$0.005 USDC",
                      "Once per scan; a second time if the first parse scores under 0.80 confidence.",
                    ],
                    [<code key="e">/api/fx</code>, "$0.001 USDC", "Only when the receipt’s currency is not USD."],
                  ]}
                />
                <p>
                  So a clean USD receipt costs the agent $0.005; a blurry euro receipt costs $0.011. Both sides of
                  every payment are recorded — what Splitsy <em>earned</em> as the seller and what Scout{" "}
                  <em>spent</em> as the buyer — and the dashboard&apos;s <strong>Scout&apos;s x402 ledger</strong> panel shows
                  the running totals, the budget left for the day, and the last payments with a link to Circle&apos;s receipt
                  for each. Scout is not the only agent that pays this way: see{" "}
                  <a href="#autopay-agents">Autopay Agents</a> for the review the Splitsy Settler buys before every
                  settlement.
                </p>

                <Subhead>Scout&apos;s wallet and on-chain identity</Subhead>
                <p>
                  Scout does not use a Circle wallet like yours. It holds a dedicated server-side account on Arc
                  whose <strong>only</strong> job is signing x402 payment authorizations — deliberately separate
                  from every user wallet, and funded with a small amount of test USDC deposited into Circle&apos;s
                  Gateway so its payments can be batched.
                </p>
                <p>
                  It is also registered as an agent on the same{" "}
                  <strong>ERC-8004 IdentityRegistry</strong> that gives payers their reputation NFTs (
                  <code>0x8004A818BFB912233c491871b3d84c89A494BD9e</code>), via{" "}
                  <code>register(metadataURI)</code>. That means the agent that scanned your receipt has a
                  publicly checkable identity: the scan result shows{" "}
                  <em>&quot;scanned by agent 0x… — see its onchain identity&quot;</em> and links straight to{" "}
                  <a href="https://testnet.arcscan.app">Arcscan</a>.
                </p>

                <Note title="A paid scan can never block your upload">
                  The paywalled path is an agent-economy demonstration layered on top of the product — it is never
                  a single point of failure for you. If the facilitator is unreachable, settlement fails, or the
                  budget is exhausted, Splitsy falls back to scanning your receipt directly with no payment at
                  all, and the result is flagged so you know the paid path degraded. Your upload always
                  completes.
                </Note>
              </Section>

              <Section id="net-settlement-treasury">
                <p>
                  Once you have joined a few bills, what you owe and what you are owed is scattered across all of
                  them. The dashboard&apos;s <strong>Treasury</strong> tab collapses that into{" "}
                  <strong>one net figure per person</strong> — and a single <strong>Settle net</strong> button
                  that discharges every open position at once.
                </p>
                <Rows
                  rows={[
                    {
                      title: "The open ledger",
                      body: (
                        <>
                          Every share you owe on bills others created, and every unpaid share owed to you on bills you
                          created — read live from the registry on Arc, not from a cached balance.
                        </>
                      ),
                    },
                    {
                      title: "One net position",
                      body: (
                        <>
                          Both directions with the same person are folded together. If Alex owes you $8 on one bill and
                          you owe Alex $12 on another, you see a single <strong>−$4.00</strong>, sorted so your largest
                          exposure is first.
                        </>
                      ),
                    },
                    {
                      title: "One settlement",
                      body: (
                        <>
                          Settle net pays every debt and collects every claimable bill in one action. On a Splitsy
                          wallet the whole thing is <strong>one atomic transaction</strong>.
                        </>
                      ),
                    },
                    {
                      title: "Claimable, separately",
                      body: (
                        <>
                          Money already paid to you but not yet withdrawn is shown as its own figure — it is yours to
                          collect and is included in the same batch.
                        </>
                      ),
                    },
                  ]}
                />

                <Note title="Netting is a view of exposure, not a shortcut around paying">
                  This is the one thing worth being precise about. Each bill <strong>escrows its own USDC</strong>{" "}
                  on Arc: <code>payDebt</code> credits the payer on <em>one specific bill</em>, and{" "}
                  <code>claim</code> pays only that bill&apos;s creator. So a debt can never be routed through a
                  third party or cancelled against a debt on a different bill. The net figure tells you your true
                  exposure; the <em>full</em> amount owed on each bill is still paid to that bill. What batching
                  removes is <strong>transactions</strong>, never the money owed — and it never collects on your
                  behalf what someone else still owes you.
                </Note>

                <Subhead>What Settle net costs to run</Subhead>
                <p>
                  Settling bill by bill means an approval plus a payment for every debt, and a claim for every
                  bill you are collecting on — <code>2 × debts + claims</code> transactions in total. What
                  replaces that depends on which wallet signs:
                </p>
                <Table
                  head={["Signing wallet", "Transactions to settle everything", "Failure behaviour"]}
                  rows={[
                    [
                      "Splitsy wallet (social sign-in)",
                      <>
                        <strong>1</strong> — every approval, payment and claim in one atomic batch
                      </>,
                      "All-or-nothing: if any leg would fail, the entire batch reverts and nothing settles.",
                    ],
                    [
                      "Connected browser wallet",
                      <>
                        <strong>1 approval + 1 per debt + 1 per claim</strong>
                      </>,
                      "Sequential: the progress modal shows exactly which step is running, and a later step failing leaves earlier ones settled.",
                    ],
                  ]}
                />
                <p>
                  The asymmetry is not arbitrary. Splitsy&apos;s social wallets are Circle{" "}
                  <strong>smart contract accounts</strong>, which can execute a batch of calls as one atomic
                  transaction; a connected browser wallet is a plain externally-owned account, which cannot, so it
                  still signs each leg. Either way a <strong>single USDC approval</strong> covers every payment
                  instead of one approval per bill.
                </p>

                <Subhead>Settling from your Splitsy wallet</Subhead>
                <Steps
                  steps={[
                    {
                      title: "Unlock the wallet",
                      body: (
                        <>
                          Because this moves money, Settle net requires your wallet PIN to be unlocked — the same
                          five-minute unlock used for a normal send. Locked, the button tells you to unlock first.
                        </>
                      ),
                    },
                    {
                      title: "Amounts are re-read from chain",
                      body: (
                        <>
                          Every outstanding amount is read fresh from the registry at the moment you press the button.
                          Nothing the browser sent is trusted, so a stale dashboard can never cause a wrong amount to
                          be signed.
                        </>
                      ),
                    },
                    {
                      title: "One batch is assembled and sent",
                      body: (
                        <>
                          One USDC approval for the summed total, one payment per debt, one claim per collectible bill —
                          packed into a single atomic transaction against your own wallet account.
                        </>
                      ),
                    },
                    {
                      title: "Reputation is scored as usual",
                      body: (
                        <>
                          Each debt settled in full earns payment reputation exactly as an individual payment would
                          (see <a href="#payment-reputation">Payment Reputation</a>). Batching changes the transaction
                          count, not the consent rules or the scoring.
                        </>
                      ),
                    },
                  ]}
                />

                <Subhead>Reading the Treasury tab</Subhead>
                <ul>
                  <li><strong>Owed to me</strong> — the sum of every unpaid share on bills you created.</li>
                  <li><strong>I owe</strong> — the sum of every unpaid share you hold on other people&apos;s bills.</li>
                  <li><strong>Net position</strong> — the difference. Positive means you are owed on balance; negative means you owe.</li>
                  <li><strong>Claimable now</strong> — money already paid into your bills that you have not yet withdrawn.</li>
                  <li>Per person, both directions are shown alongside the net, labelled with their handle where Splitsy knows it and a shortened address where it does not.</li>
                  <li>The tab shares the dashboard&apos;s wallet scope selector. With both a Splitsy wallet and a browser wallet connected you must pick which one settles, because each signs differently.</li>
                  <li>On sample data (<code>?demo=1</code>) the figures render but settling is disabled.</li>
                </ul>
              </Section>

              <Section id="architecture">
                <Rows
                  rows={[
                    {
                      title: "Experience layer",
                      body: (
                        <>
                          The Splitsy web app handles receipt upload, bill review, split editing, wallet connection, debt payment,
                          claim flows, recurring tab creation, approval management, tab selection, and event display.
                        </>
                      ),
                    },
                    {
                      title: "Service layer",
                      body: (
                        <>
                          Receipt extraction, currency conversion, and recurring settlement automation are handled outside the payment
                          interface so users only see the actions they need.
                        </>
                      ),
                    },
                    {
                      title: "Contracts",
                      body: (
                        <>
                          <code>BillSplitRegistry</code> stores one-time debts. <code>RecurringTabFactory</code> creates recurring tab
                          contracts. <code>RecurringTab</code> handles fixed-share scheduled collection and claimable balances.
                        </>
                      ),
                    },
                    {
                      title: "Integration layer",
                      body: (
                        <>
                          Wallet, contract, and Circle bridge integrations are separated from the interface so payment flows remain
                          consistent across one-time bills and recurring tabs.
                        </>
                      ),
                    },
                  ]}
                />
                <Rows
                  rows={[
                    {
                      title: "Application interface",
                      body: "A responsive web experience for receipt upload, bill review, split creation, wallet connection, and recurring payment management.",
                    },
                    {
                      title: "Typed transaction layer",
                      body: "Strongly typed contract reads and writes for USDC payments, approvals, event history, and Arc Testnet wallet interactions.",
                    },
                    {
                      title: "Solidity contracts",
                      body: "Bill registry and recurring tab contracts define the accounting rules that keep payments verifiable onchain.",
                    },
                    {
                      title: "Circle Gateway",
                      body: "Permissionless cross-chain USDC payments from Avalanche, Base, or Ethereum into Arc Testnet using EIP-712 burn intents and Gateway attestation.",
                    },
                    {
                      title: "CCTP",
                      body: "Native USDC burn-and-mint movement between supported source chains and Arc, underpinning the Gateway flow.",
                    },
                    {
                      title: "Settlement automation",
                      body: "Protected automation checks recurring tabs on a schedule so payers do not need to press a settle button each cycle.",
                    },
                    {
                      title: "Agent economy",
                      body: "Per-account autopay agents settle debtor shares as ERC-8183 jobs, with an independent evaluator releasing the escrowed fee and paid bill review bought over x402.",
                    },
                  ]}
                />
              </Section>

              <Section id="contracts">
                <p>
                  Contracts are intentionally narrow. They store the minimum accounting state needed for payment enforcement and emit
                  events for app indexing, explorer review, and user-facing history.
                </p>
                <Table
                  head={["Contract", "Purpose", "Important events"]}
                  rows={[
                    [
                      <code key="c">BillSplitRegistry</code>,
                      "Creates bills, records participant debts, accepts partial or full payments, and lets splitters claim paid funds.",
                      <>
                        <code>BillCreated</code>, <code>DebtPaid</code>, <code>FundsClaimed</code>
                      </>,
                    ],
                    [
                      <code key="c">RecurringTabFactory</code>,
                      "Deploys isolated recurring tab contracts and forwards scheduled settlement calls by tab id.",
                      <code key="e">TabCreated</code>,
                    ],
                    [
                      <code key="c">RecurringTab</code>,
                      "Calculates accrued member obligations, transfers available USDC, records shortfalls, and exposes claimable funds.",
                      <>
                        <code>MemberSettled</code>, <code>SettlementShortfall</code>, <code>TabSettled</code>, <code>FundsClaimed</code>
                      </>,
                    ],
                  ]}
                />
                <p>
                  The payment contracts build on a small set of shared, audited security primitives rather than external dependencies.
                  Each is intentionally minimal and carries no owner, upgrade, or privileged path.
                </p>
                <Table
                  head={["Module", "Type", "Role"]}
                  rows={[
                    [
                      <code key="m">ReentrancyGuard</code>,
                      "Abstract base",
                      <>
                        Provides the <code>nonReentrant</code> modifier. Every fund-moving entrypoint (<code>payDebt</code>, <code>claim</code>, <code>settleTab</code>) inherits it, so a function cannot be re-entered while it executes.
                      </>,
                    ],
                    [
                      <code key="m">SafeERC20</code>,
                      "Library",
                      <>
                        Wraps <code>transfer</code> and <code>transferFrom</code> so a token that returns no data or <code>false</code> can never be mistaken for a successful transfer; any non-success reverts with <code>SafeERC20FailedOperation</code>.
                      </>,
                    ],
                    [
                      <code key="m">IERC20</code>,
                      "Interface",
                      <>
                        Minimal ERC-20 surface (<code>allowance</code>, <code>balanceOf</code>, <code>transfer</code>, <code>transferFrom</code>) the contracts use to read approvals and balances and to move USDC.
                      </>,
                    ],
                  ]}
                />
                <Note title="Deployment note">
                  Existing recurring tabs keep the bytecode they were created with. Changes to <code>RecurringTab.sol</code> require a
                  new factory deployment and newly created tabs to use the updated behavior.
                </Note>
              </Section>

              <Section id="operations">
                <p>
                  Recurring settlement is designed to be automatic after user approval. Payers maintain enough USDC and allowance for
                  the tab, while Splitsy periodically checks whether a cycle is due and collectible.
                </p>
                <p>
                  If a payer has insufficient balance or allowance, the contract records a shortfall and Splitsy can collect the
                  unpaid portion later after the payer funds or re-approves their wallet. Recipients can claim collected funds when a
                  claimable balance is available.
                </p>
                <p>
                  <a href="#autopay-agents">Autopay agents</a> are the debtor-side equivalent and are funded by the user, not by
                  the operator: an agent that runs out of USDC skips with <code>agent_unfunded</code> and creates nothing on
                  chain, so restoring it is a top-up rather than an operator action. The Splitsy Settler and Auditor pay for
                  their own transactions out of their own balances, and an unset settlement configuration reads as autopay{" "}
                  <strong>off</strong> — never as &quot;settle without the job&quot;.
                </p>
              </Section>

              <Section id="security">
                <ul>
                  <li>Users explicitly approve USDC spend before contracts can pull funds.</li>
                  <li>Recurring approval is constrained to the tab contract address and can be revoked by setting allowance to zero.</li>
                  <li>Recurring settlement is protected by operational controls and is not exposed as a public user action.</li>
                  <li>Every fund-moving entrypoint follows checks-effects-interactions and is guarded by the shared <code>ReentrancyGuard</code> (<code>nonReentrant</code>) module.</li>
                  <li>All USDC movement routes through the <code>SafeERC20</code> library, so a token that returns no data or <code>false</code> can never be treated as a successful transfer.</li>
                  <li>Contracts hold no privileged owner and expose no upgrade, pause, sweep, or <code>selfdestruct</code> path; funds can only ever leave to a bill&apos;s splitter or a tab&apos;s immutable recipient.</li>
                  <li>Sensitive operational credentials must never be exposed in browser code, screenshots, public docs, or client logs.</li>
                  <li>Contracts use custom errors and explicit checks for invalid amounts, unknown bills, unauthorized claims, and duplicate recurring members.</li>
                  <li>Receipt OCR data should be reviewed by the splitter before submission. The scanner is a convenience layer, not an accounting authority.</li>
                  <li>Bridge flows depend on the connected wallet signing each step and on Circle attestation for CCTP minting.</li>
                  <li>Payment reputation is consent-based and positive-only: a score can only be created by a payment the wallet itself made, and every entry is re-verifiable against the on-chain payment it commits to (see <a href="#payment-reputation">Payment Reputation</a>).</li>
                  <li>An <a href="#autopay-agents">autopay agent</a> spends only the USDC you transferred to it — Splitsy holds no allowance on your own wallet for it — so its balance is a hard ceiling no rule, bug, or compromised server can exceed.</li>
                  <li>Each settlement job uses three distinct wallets for client, provider, and evaluator, so the agent that is paid for a job is never the agent that decides it was done. The evaluator re-reads the registry on chain rather than trusting the provider&apos;s claim.</li>
                </ul>
                <Note title="Disclaimer & acknowledgments">
                  Splitsy is an experimental demo on Arc Testnet that uses test USDC only — no real funds — and is not
                  affiliated with any referenced brand. See the full <Link href="/disclaimer">disclaimer and
                  acknowledgments</Link> for testnet, trademark, privacy, and liability details.
                </Note>
              </Section>

              <Section id="configuration">
                <p>
                  Splitsy should be connected to the intended Arc Testnet contracts before users create bills or recurring tabs.
                  Contract addresses, USDC token settings, bridge support, receipt scanning, and settlement automation are managed by
                  the operator during deployment.
                </p>
                <Rows
                  rows={[
                    {
                      title: "For users",
                      body: (
                        <>
                          Use a compatible browser wallet, switch to the supported Arc Testnet network, keep enough USDC for payments, and
                          review every wallet prompt before signing.
                        </>
                      ),
                    },
                    {
                      title: "For operators",
                      body: (
                        <>
                          Keep sensitive operational configuration outside public documentation. Publish only user-safe details such as supported
                          network, supported asset, verified contract addresses, and contract source links.
                        </>
                      ),
                    },
                  ]}
                />
              </Section>
            </article>
          </div>
        </div>
      </main>
    </div>
  );
}
