import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";

import { ARC_EXPLORER } from "@/lib/arc-explorer";
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
  description:
    "User and technical documentation for Splitsy: IOUs, bill splitting, recurring payments, paying someone with no wallet, Circle Gateway cross-chain payments, and Arc settlement.",
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
            Splitsy turns what people owe each other into USDC payments you can check. It takes a debt stated in one
            sentence or a photographed receipt, works out who owes what, records it on Arc, lets payers settle from a
            wallet they get by signing in, holds money for people who have not signed in yet, and collects recurring
            tabs when a cycle becomes due.
          </p>

          {/* The four facts a reader wants before the first section. It was a
              bordered panel floated beside the title; it is the app's own
              labelled rail now. A <dl>, because four labelled facts are a
              definition list and the one thing here a screen reader can announce
              as pairs. */}
          <dl className="bill-contents doc-glance">
            {[
              { label: "Primary asset", value: "USDC" },
              { label: "Network", value: "Arc Testnet · test USDC only" },
              { label: "Payment types", value: "IOUs, one-time bills and recurring tabs" },
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
            Every section in four parts, and the only place in the document that
            earns the full 88rem. The counts are read from the outline, so adding
            a section never needs an edit here. [data-parts] is the shared rule:
            how many parts a document has is the document's business. */}
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
                  Splitsy is built for groups that need more than a calculator screenshot. State a debt in one sentence, or
                  upload a receipt, review the extracted bill and assign payer shares. Payers sign in later, see only their
                  own debts, pay in full or partially, and bridge USDC into Arc when their balance lives on another
                  supported chain.
                </p>
                <p>
                  The application has three product surfaces. An <strong>IOU</strong> is a single debt stated as a sentence.{" "}
                  <strong>Bills</strong> are one-time debts linked to a receipt or expense, split across several people.{" "}
                  <strong>Recurring</strong> tabs are scheduled payment agreements, such as rent, subscriptions, shared
                  services, or repeating household costs. All three are designed around explicit approval and visible
                  balances.
                </p>
                <Rows
                  rows={[
                    {
                      title: "One sentence, one debt",
                      body: (
                        <>
                          &quot;@dani owes me $42&quot; files a debt on Arc; &quot;I owe @dani $42&quot; pays it. No receipt, no
                          split screen — see <a href="#ious">IOUs</a>.
                        </>
                      ),
                    },
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
                      title: "A wallet from signing in",
                      body: (
                        <>
                          Signing in with X, Discord, Google or an email code gives you a working USDC wallet on Arc — no seed
                          phrase, nothing to install. Browser wallets work too, discovered over EIP-6963 and signed through
                          Viem.
                        </>
                      ),
                    },
                    {
                      title: "Pay someone with no wallet",
                      body: (
                        <>
                          Money sent to a handle nobody has signed in as waits in an escrow contract and is released on that
                          person&apos;s first sign-in. The sender can take it back until then.
                        </>
                      ),
                    },
                    {
                      title: "Pay cross-chain with Gateway",
                      body: (
                        <>
                          Payers with USDC on Avalanche, Base, or Ethereum can pay directly from those chains to Arc. Gateway burns
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
                <p>
                  Two ways in. The <strong>IOU</strong> tab is one sentence and is what the app opens on; the{" "}
                  <strong>Bills</strong> tab is the full path below — a receipt, a split, and a share per person. Everything
                  after step 04 is the same either way.
                </p>
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
                          Use equal split for a quick division or manual split when participants owe different amounts. Tag each payer by
                          handle, email or wallet address; anyone who has not signed in yet is filed under a{" "}
                          <a href="#no-wallet-yet">derived slot</a> rather than a wallet somebody else holds.
                        </>
                      ),
                    },
                    {
                      title: "Submit the bill",
                      body: (
                        <>
                          The splitter creates a bill in the BillSplitRegistry contract. The contract stores a metadata hash, participant
                          addresses, and each participant&apos;s owed USDC amount. An optional &quot;pay by&quot; date is committed with
                          it, and unlocks <a href="#bill-verification">all-or-nothing</a> bills.
                        </>
                      ),
                    },
                    {
                      title: "Payers settle",
                      body: (
                        <>
                          Payers sign in or connect the matching wallet, approve the registry for the selected USDC amount, and call the
                          payment flow. Payments can be partial as long as they do not exceed the remaining debt.
                        </>
                      ),
                    },
                    {
                      title: "Splitter claims",
                      body: (
                        <>
                          Paid funds accumulate as claimable balance in the registry. The splitter can claim any amount up to the available
                          paid balance — or clear every open position at once from the{" "}
                          <a href="#net-settlement-treasury">Treasury tab</a>.
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
                      title: "A wallet that is yours from the first login",
                      body: (
                        <>
                          Signing in creates an <strong>embedded wallet</strong> — a real Arc account with its own address, whose key is
                          generated and held inside Privy&apos;s secure enclave, not by Splitsy. You can receive USDC to it, send from
                          it, and view it on the block explorer. There is no seed phrase to write down and nothing to install.
                        </>
                      ),
                    },
                    {
                      title: "Every payment is a prompt you approve",
                      body: (
                        <>
                          Splitsy&apos;s server prepares a transaction; your wallet shows you what it is; nothing moves until you confirm.
                          A bill payment is an approval followed by a payment, so it shows <strong>two</strong> prompts — two
                          transactions really are being signed.
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
                          Your wallet is keyed to your provider identity, idempotently — the same identity always maps to the same
                          wallet. Splitsy stores your handle/email, avatar, and wallet address so friends can tag you.
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
                      title: "Discover what you owe — and what is waiting for you",
                      body: (
                        <>
                          Any bill already tagged to your handle or email is linked to you on sign-in and appears under your unpaid bills.
                          If somebody paid you before you had a wallet, that money is{" "}
                          <a href="#no-wallet-yet">released out of escrow</a> during this same login.
                        </>
                      ),
                    },
                  ]}
                />

                <Subhead>Who holds the key</Subhead>
                <p>
                  A wallet has to be created for you the instant you sign in — otherwise a debtor cannot pay a dinner split
                  without first learning what a seed phrase is. There are two ways to do that, and a Splitsy deployment picks
                  one. What the live deployment runs is the <strong>embedded wallet</strong>: the key is generated inside
                  Privy&apos;s enclave and tied to your login, Splitsy never sees it, and every transaction needs your
                  confirmation. Custody is yours from the first second, not handed over later.
                </p>
                <p>
                  The alternative — a Circle <strong>developer-controlled wallet</strong> — is created and operated
                  server-side against a reference id. It buys one real advantage: it is a smart contract account, so it can
                  execute several calls as a single atomic transaction, which is why{" "}
                  <a href="#net-settlement-treasury">Settle net</a> costs one transaction there and two on an embedded
                  wallet. It costs the thing that matters more, which is that the server can move your money, so sends are
                  gated behind a <strong>PIN</strong> you set (five-minute unlock, stored only as a salted{" "}
                  <code>scrypt</code> hash) rather than behind a signature only you can make.
                </p>
                <Table
                  head={["Property", "Embedded wallet (live)", "Developer-controlled wallet"]}
                  rows={[
                    ["Who can sign", "Only you, in the wallet's own prompt", "The server, behind your PIN"],
                    ["Account type", "EOA", "Smart contract account (SCA)"],
                    ["Works from a handle/email alone", "Yes — created at sign-in", "Yes — created at sign-in"],
                    ["Onboarding steps for a newcomer", "None beyond signing in", "None beyond signing in, plus setting a PIN"],
                    [
                      "Settle net",
                      <>
                        1 <code>approve</code> + 1 <code>settle</code>
                      </>,
                      <>
                        1 atomic <code>executeBatch</code>
                      </>,
                    ],
                  ]}
                />
                <p>
                  Because Splitsy runs on <strong>Arc Testnet with test USDC that has no monetary value</strong>, neither
                  choice carries financial risk today. That is also why the comparison is worth reading rather than glossing:
                  it is the decision a real-money deployment turns on.
                </p>

                <Subhead>Two rails for a debt</Subhead>
                <p>
                  <code>BillSplitRegistry</code> records debts by wallet address and needs every participant&apos;s address at
                  creation time. A handle you tag may belong to someone who has not signed in yet, so their share is filed
                  under a <strong>derived slot</strong> — an address computed from their handle that nobody holds a key to
                  (see <a href="#no-wallet-yet">Paying someone with no wallet</a>). The bill is a real on-chain bill either
                  way; the slot is just the name the debt is filed under until its owner signs in.
                </p>
                <p>
                  Alongside that registry rail there is an <strong>off-chain ledger</strong> for debts that are settled
                  wallet-to-wallet rather than through the contract: the debt is stored keyed by provider + handle/email, and
                  is linked to a real wallet the moment that person signs in. It is a deliberate second mode, not a fallback
                  — some debts do not want a contract in the middle.
                </p>
                <Rows
                  rows={[
                    {
                      title: "Direct settlement",
                      body: (
                        <>
                          On the off-chain rail your wallet sends USDC <strong>directly to the creditor&apos;s wallet</strong> on Arc — no
                          escrow contract in the middle. Splitsy prepares the transfer, confirms it, and marks the debt paid. Paid bills
                          move to the history at the foot of your Dashboard with an explorer link.
                        </>
                      ),
                    },
                    {
                      title: "Send, receive, and history",
                      body: (
                        <>
                          Your wallet widget shows your live USDC balance, a copyable receive address, a send form, and a transaction
                          history — each entry with a link to the Arc block explorer.
                        </>
                      ),
                    },
                  ]}
                />

                <Note title="What Splitsy stores about you">
                  Only your provider identity (an id/handle, or email for Google/email sign-in), display name, avatar URL, wallet
                  address, and — on a deployment that uses PIN-gated sends — a salted hash of that PIN. No tokens in the browser,
                  and no provider content beyond your basic profile. Everything you can pay or be paid is test USDC on Arc Testnet.
                </Note>
              </Section>

              <Section id="ious">
                <p>
                  An IOU is a debt stated as one sentence. Pick a direction, name a person by handle, email or wallet address,
                  type an amount, and add a note if it needs one. There is no receipt to scan and no split to review, and it is
                  the tab the app opens on.
                </p>
                <p>
                  The two directions are <strong>not</strong> two styles of the same record. They travel different rails,
                  because the contract decides who a bill&apos;s creditor is:
                </p>
                <Table
                  head={["What you say", "What happens", "Why it has to be that way"]}
                  rows={[
                    [
                      <>
                        &quot;<strong>@dani owes me</strong> $42&quot;
                      </>,
                      <>
                        A one-participant bill in <code>BillSplitRegistry</code>, created by your wallet with Dani as the only
                        participant.
                      </>,
                      <>
                        <code>createBill</code> makes the sender the bill&apos;s splitter, and <code>claim</code> pays only the
                        splitter — so an on-chain bill can only ever be raised <em>by</em> the person who is owed.
                      </>,
                    ],
                    [
                      <>
                        &quot;<strong>I owe @dani</strong> $42&quot;
                      </>,
                      <>A direct USDC transfer to Dani&apos;s wallet, or a deposit into escrow if Dani has none yet.</>,
                      <>
                        The registry cannot hold this one: it would need Dani to be the splitter, which means signing{" "}
                        <code>createBill</code> from someone else&apos;s wallet. You already hold the money and you are the one
                        who owes it, so there is nothing for a contract to coordinate.
                      </>,
                    ],
                  ]}
                />

                <Rows
                  rows={[
                    {
                      title: "Anyone, by any name",
                      body: (
                        <>
                          A <code>0x</code> address, an email, or a bare X/Discord handle. Addresses and emails are detected from
                          their shape; for a bare handle you pick the network it belongs to.
                        </>
                      ),
                    },
                    {
                      title: "A ledger under the composer",
                      body: (
                        <>
                          Every IOU you have raised or settled is listed as the same sentence, small, with what is still open. The
                          figures are read from the registry on Arc, not from a cached balance.
                        </>
                      ),
                    },
                    {
                      title: "Nobody home is still an answer",
                      body: (
                        <>
                          &quot;I owe&quot; to someone with no wallet goes into{" "}
                          <a href="#no-wallet-yet">escrow</a> rather than nowhere. A failed lookup is never read as &quot;no
                          wallet&quot; — that would escrow money away from someone who could have been paid directly.
                        </>
                      ),
                    },
                    {
                      title: "Signed the same way as everything else",
                      body: (
                        <>
                          Your wallet approves it, whichever kind of wallet you use. An &quot;owes me&quot; IOU is one transaction;
                          an &quot;I owe&quot; is a transfer, or an approval plus a deposit when it goes into escrow.
                        </>
                      ),
                    },
                  ]}
                />

                <Note title="An IOU you raise is a real bill">
                  It carries a bill id, it is visible on the explorer, it earns the payer{" "}
                  <a href="#payment-reputation">payment reputation</a> when they settle it, and it shows up in your{" "}
                  <a href="#net-settlement-treasury">net position</a> beside everything else. The only thing it lacks is a
                  receipt, so the <a href="#bill-verification">verification badge</a> reports &quot;genuine, no receipt&quot; —
                  there is no image to cross-check a total against.
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
                      <code key="fn">createBill(bytes32,address[],uint256[],…)</code>,
                      <>
                        Registers participant debts and emits <code>BillCreated</code>. An optional due date and an
                        all-or-nothing flag are part of the same call.
                      </>,
                    ],
                    [
                      "Pay debt",
                      <code key="fn">payDebt(uint256,uint256)</code>,
                      "Transfers USDC from payer to the registry and updates paid totals.",
                    ],
                    [
                      "Pay someone else's debt",
                      <code key="fn">payDebtFor(uint256,address,uint256)</code>,
                      <>
                        Pulls from the caller but credits the named debtor, and emits <code>DebtPaid</code> naming the{" "}
                        <em>debtor</em> — which is how an <a href="#autopay-agents">autopay agent</a> pays your share without
                        taking your reputation.
                      </>,
                    ],
                    [
                      "Claim funds",
                      <code key="fn">claim(uint256,uint256)</code>,
                      "Allows only the splitter to withdraw paid, unclaimed funds.",
                    ],
                    [
                      "Settle everything at once",
                      <code key="fn">settle(uint256[],uint256[],uint256[])</code>,
                      <>
                        Claims every listed bill, then pays every listed debt, in one transaction — claims first, so their
                        proceeds can fund the payments. See{" "}
                        <a href="#net-settlement-treasury">Net-settlement treasury</a>.
                      </>,
                    ],
                    [
                      "Take a contribution back",
                      <>
                        <code>refund(uint256)</code>, <code>refundSlot(…)</code>
                      </>,
                      <>
                        Returns a payer&apos;s own contribution when an all-or-nothing bill has failed.{" "}
                        <code>refundSlot</code> does the same for a share filed under a{" "}
                        <a href="#no-wallet-yet">derived slot</a>, paying the person&apos;s real wallet instead.
                      </>,
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
                <Note title="Bill ids belong to a registry, not to Splitsy">
                  Ids restart at 1 in every deployment of the contract, so bill <code>#7</code> only means something next to the
                  registry address it came from. When the registry is redeployed the previous one stays readable, so history
                  survives — but the two number spaces never merge.
                </Note>
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

              <Section id="no-wallet-yet">
                <p>
                  You can name someone who has never opened Splitsy. What happens next depends on whether money is{" "}
                  <strong>moving now</strong> or a debt is merely being <strong>recorded</strong>, and the two answers are
                  different on purpose.
                </p>
                <Table
                  head={["Situation", "Where it goes", "Who can move it"]}
                  rows={[
                    [
                      <>
                        You <strong>pay</strong> a handle with no wallet (an &quot;I owe&quot; IOU)
                      </>,
                      <>
                        Into the <code>HandleEscrow</code> contract, against a hash of their handle.
                      </>,
                      <>
                        Them, at their first sign-in — or you, any time before that, with <code>reclaim</code>.
                      </>,
                    ],
                    [
                      <>
                        You <strong>record</strong> what a handle owes (a bill share, a tab member)
                      </>,
                      <>
                        Nowhere. The share is filed against a <strong>derived slot</strong> — an address computed from the
                        handle.
                      </>,
                      <>
                        Nobody. No money is ever sent there; a slot is a filing name, not an account.
                      </>,
                    ],
                  ]}
                />

                <Subhead>Money waiting for a person: HandleEscrow</Subhead>
                <p>
                  The escrow holds USDC against <code>keccak256(&quot;provider:handle&quot;)</code> and knows nothing else about
                  the recipient. Three entry points, and each one exists to close a specific hole:
                </p>
                <Table
                  head={["Call", "Who can call it", "What it does"]}
                  rows={[
                    [
                      <code key="c">deposit(handleHash, amount)</code>,
                      "the sender",
                      "Moves the USDC in and returns a deposit id. Splitsy records who it is for, off-chain.",
                    ],
                    [
                      <code key="c">release(id, to, deadline, signature)</code>,
                      "anyone, with the attester's signature",
                      <>
                        Pays the deposit to <code>to</code>. Splitsy relays it during the recipient&apos;s first sign-in and pays
                        the gas, so a person with no wallet and no USDC can still be paid.
                      </>,
                    ],
                    [
                      <code key="c">reclaim(id)</code>,
                      "only the depositor",
                      "Takes the money back, unconditionally, any time before a release.",
                    ],
                  ]}
                />
                <Note title="Why an unconditional reclaim is the safety net">
                  The signing key that authorises releases is <strong>immutable</strong> — the contract has no setter and no
                  owner, so changing it means deploying a new escrow. That is only an acceptable design because{" "}
                  <code>reclaim</code> has no conditions on it: if the key were ever compromised, every depositor can pull their
                  own money out ahead of it, and the contract is replaced. The two decisions hold each other up, and neither
                  works alone.
                </Note>
                <p>
                  A release signature binds the deposit id, the recipient address and a deadline, so it authorises exactly one
                  payout to exactly one wallet. It cannot invent an amount — the contract pays what that deposit holds — and it
                  cannot be replayed on another deployment, because the chain id and the contract address are part of what is
                  signed.
                </p>
                <p>
                  If the relaying wallet runs out of USDC (Arc charges gas in USDC), releases simply stop happening: deposits
                  stay safe and reclaimable and the sign-in still succeeds. Money that is late is recoverable; money released
                  to the wrong wallet is not, so the failure is deliberately on the cautious side.
                </p>

                <Subhead>A name with no key: derived slots</Subhead>
                <p>
                  A slot address is the low 160 bits of{" "}
                  <code>keccak256(&quot;provider:handle&quot;)</code>. Tagging <code>@dani</code> on two bills therefore files
                  both shares against the same address, and <strong>nobody holds a key to it</strong> — not Dani, not Splitsy,
                  not ever. That is the property that makes it safe to use as a filing name and unsafe to send money to.
                </p>
                <p>
                  It replaced something worse. Before, a tagged stranger had a wallet <em>minted</em> for them under
                  Splitsy&apos;s key: they were told they owed money at an address they did not control, and unwinding a failed
                  bill out of it cost three transactions and leaked gas every time. A derived slot has nothing to hold and
                  nothing to leak.
                </p>
                <p>
                  One thing still genuinely needs a key, and that is refunding a failed all-or-nothing bill:{" "}
                  <code>refund</code> pays whoever calls it, and a slot has nobody to be the caller.{" "}
                  <code>refundSlot(billId, slot, to, deadline, signature)</code> is the registry&apos;s answer — anyone may
                  relay it, the attester&apos;s signature authorises it, and it pays <code>to</code>, the person&apos;s real
                  wallet, rather than the slot. The signature binds all four arguments, so it can neither pay a
                  non-participant nor invent an amount.
                </p>
                <Note title="What a stolen signing key could and could not do">
                  One key signs both escrow releases and slot refunds — one key to guard rather than two. What that concedes is
                  bounded and worth stating plainly: a stolen key could misdirect a release or a refund to a wallet of its
                  choosing. It could not take money the escrow was never given, could not touch a paid bill that has not
                  failed, could not invent an amount, and could not beat a depositor who reclaims first.
                </Note>
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
                  <code>
                    createBill(bytes32 metadataHash, address[] participants, uint256[] amounts, uint64 dueDate, bool
                    escrowUntilFull)
                  </code>
                  . The contract emits <code>BillCreated</code> with that hash; it can never be edited afterward.
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
                  the <a href="https://eips.ethereum.org/EIPS/eip-8004">ERC-8004</a> registries Arc pre-deploys on both of its
                  networks — no Splitsy contract is involved. The payer&apos;s wallet receives an <strong>identity NFT</strong> on the
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
                <Note title="Reputation is switched on, not assumed">
                  Both registries are Arc&apos;s own, and Arc mainnet has its own pair at different addresses. Splitsy treats
                  them as <strong>opt-in</strong>: with the addresses unconfigured, reputation is off and off is silent —
                  payments still succeed, and nothing is minted or scored. Turning it on spends gas from Splitsy&apos;s
                  registrar and validator wallets on the first bill anybody pays, which is why it is a deliberate act per
                  deployment rather than a default.
                </Note>

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
                          identity NFT. A wallet Splitsy can sign for signs its own registration (it just paid, so it holds
                          gas); a wallet Splitsy holds no key for — an embedded wallet, or a connected browser wallet — has a
                          dedicated <strong>registrar</strong> wallet mint on its behalf, which then transfers the NFT to the
                          payer. Every payer ends up owning their own identity.
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
                      "Owns (or is bound to) the identity NFT being scored. A wallet Splitsy can sign for registers itself.",
                    ],
                    [
                      "Registrar",
                      "A dedicated Splitsy wallet",
                      "Mints identity NFTs for payers Splitsy cannot sign as — embedded wallets and connected browser wallets — then transfers each NFT to its payer. It holds those NFTs at mint time, which is exactly why it must not also score them.",
                    ],
                    [
                      "Validator",
                      "A second dedicated Splitsy wallet",
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
                          On <a href={ARC_EXPLORER}>Arcscan</a>, open the ReputationRegistry address above and
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
                  Splitsy uses Circle and Arc technology for USDC movement and settlement. Arc is the destination network for
                  the app&apos;s contracts. Circle Gateway enables cross-chain USDC payments from any supported source chain
                  directly to Arc in one flow.
                </p>
                <Subhead>Two networks, one switch</Subhead>
                <p>
                  Arc has a test network and a live one, and a Splitsy deployment runs on exactly one of them. Which one is a
                  single setting, and everything that follows from it — chain id, RPC, explorer, USDC address, the two Gateway
                  contracts — is resolved from that one answer rather than configured value by value. This deployment is on{" "}
                  <strong>Arc Testnet</strong>, where USDC is test USDC and has no monetary value.
                </p>
                <Table
                  head={["", "Arc Testnet (here)", "Arc mainnet"]}
                  rows={[
                    ["Chain id", <code key="v">5042002</code>, <code key="v">5042</code>],
                    ["Explorer", "testnet.arcscan.app", "explorer.arc.io"],
                    ["USDC", "the same predeploy address on both", "—"],
                    ["What the money is", "test USDC, no value", "real USDC"],
                  ]}
                />
                <p>
                  The rule the switch is built around is that being wrong must be cheap: anything other than the exact word for
                  mainnet resolves to testnet, and a mainnet deployment missing an address refuses to act rather than quietly
                  reading a test contract. Two things are not available on mainnet at all — the ERC-8183 job contract the{" "}
                  <a href="#autopay-agents">autopay ceremony</a> runs on is not deployed there, and the batching SDK{" "}
                  <a href="#scout-agent">Scout</a> pays through has no mainnet Arc support — so those two features are off
                  rather than approximated.
                </p>
                <Rows
                  rows={[
                    {
                      title: "Circle Gateway",
                      body: (
                        <>
                          Pay from <strong>any supported chain</strong> (on testnet: Avalanche Fuji, Base Sepolia, Ethereum Sepolia) and
                          settle on Arc. Two-step flow: sign an EIP-712 burn intent on the source chain (gas-free), then execute the mint
                          transaction on Arc. No bridge UI, no waiting — native USDC moves chain-to-chain in seconds.
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
                          Arc is EVM-compatible, uses USDC as its gas token, and supports CCTP-based USDC bridging. Gateway&apos;s
                          GatewayMinter contract on Arc handles the final mint step after attestation, at a different address on each
                          network. Gas in USDC is why an agent&apos;s balance has to cover gas as well as the payment it makes.
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
                          The per-transaction ceiling is additionally enforced inside the wallet provider&apos;s own enclave, so
                          it holds even against a bug in Splitsy&apos;s rule code.
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
                  <a href={ARC_EXPLORER}>Arcscan</a>.
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
                      "The same transfer, prepared by the server and sent from the wallet you signed in with.",
                      "Your approval — the wallet's own confirmation prompt, or your PIN on a deployment that uses PIN-gated sends.",
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
                  Scout does not use a wallet like yours. It holds a dedicated server-side account on Arc whose{" "}
                  <strong>only</strong> job is signing x402 payment authorizations — deliberately separate from every user
                  wallet, and funded with a small amount of test USDC deposited into Circle&apos;s Gateway so its payments can
                  be batched. Batching is also what limits Scout to the test network: the SDK it pays through has no Arc
                  mainnet support, so a mainnet deployment runs with Scout switched off rather than paying real USDC on a
                  test chain.
                </p>
                <p>
                  It is also registered as an agent on the same{" "}
                  <strong>ERC-8004 IdentityRegistry</strong> that gives payers their reputation NFTs (
                  <code>0x8004A818BFB912233c491871b3d84c89A494BD9e</code>), via{" "}
                  <code>register(metadataURI)</code>. That means the agent that scanned your receipt has a
                  publicly checkable identity: the scan result shows{" "}
                  <em>&quot;scanned by agent 0x… — see its onchain identity&quot;</em> and links straight to{" "}
                  <a href={ARC_EXPLORER}>Arcscan</a>.
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
                          Settle net pays every debt and collects every claimable bill in one action. The registry carries the
                          whole batch in a single <code>settle</code> call, so it lands or reverts as one thing.
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
                  replaces that is one <code>settle(claimIds, payIds, amounts)</code> call on the registry, which runs every
                  claim first — so the money you collect can fund the payments in the same transaction — and then every
                  payment, all-or-nothing. A pay amount of zero means &quot;whatever I still owe&quot;, worked out at
                  execution time, so a payment that lands while you are signing cannot make the batch revert on a stale
                  figure.
                </p>
                <p>
                  How many transactions that takes depends only on whether your wallet can bundle the USDC approval with it:
                </p>
                <Table
                  head={["Signing wallet", "Transactions to settle everything", "Failure behaviour"]}
                  rows={[
                    [
                      "Splitsy wallet — smart contract account",
                      <>
                        <strong>1</strong> — the approval and the <code>settle</code> in one atomic batch
                      </>,
                      "All-or-nothing: if any leg would fail, the entire batch reverts and nothing settles.",
                    ],
                    [
                      "Splitsy wallet — embedded wallet, or a connected browser wallet",
                      <>
                        <strong>2</strong> — one <code>approve</code>, then one <code>settle</code>
                      </>,
                      <>
                        The <code>settle</code> is still all-or-nothing. A dropped second prompt leaves an unspent approval,
                        never a half-paid bill.
                      </>,
                    ],
                  ]}
                />
                <p>
                  The asymmetry is not arbitrary, and it is not about leg count — two transactions cover ten bills exactly as
                  they cover one. A smart contract account can execute several calls as a single atomic transaction, so the
                  approval rides along; an ordinary account cannot, so the approval is its own prompt. Which of the two a
                  request is sending is read from the approval already on chain rather than counted in the browser, so a
                  reload picks up wherever the chain actually is. A selection with nothing to pay costs one transaction —
                  there is no approval to send.
                </p>

                <Subhead>Settling from your Splitsy wallet</Subhead>
                <Steps
                  steps={[
                    {
                      title: "Approve it in your wallet",
                      body: (
                        <>
                          Because this moves money, it needs your approval — the wallet&apos;s own confirmation prompt, or your
                          PIN on a deployment that uses PIN-gated sends. Until then the button tells you so rather than
                          starting.
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
                      title: "The batch is assembled and sent",
                      body: (
                        <>
                          One USDC approval for the summed total, then one <code>settle</code> carrying a claim for every
                          collectible bill and a payment for every debt — as a single atomic transaction if your wallet can
                          bundle the approval, and as two otherwise.
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
                          The Splitsy web app handles the IOU composer, receipt upload, bill review, split editing, wallet connection,
                          debt payment, claim flows, recurring tab creation, approval management, tab selection, and event display.
                        </>
                      ),
                    },
                    {
                      title: "Service layer",
                      body: (
                        <>
                          Receipt extraction, currency conversion, escrow releases at sign-in, and recurring settlement automation are
                          handled outside the payment interface so users only see the actions they need.
                        </>
                      ),
                    },
                    {
                      title: "Contracts",
                      body: (
                        <>
                          <code>BillSplitRegistry</code> stores one-time debts and the batched <code>settle</code>.{" "}
                          <code>HandleEscrow</code> holds money for a person who has no wallet yet.{" "}
                          <code>RecurringTabFactory</code> creates recurring tab contracts, and <code>RecurringTab</code> handles
                          fixed-share scheduled collection and claimable balances.
                        </>
                      ),
                    },
                    {
                      title: "Integration layer",
                      body: (
                        <>
                          Wallet, contract, and Circle bridge integrations are separated from the interface so payment flows remain
                          consistent across IOUs, one-time bills and recurring tabs. One module decides which Arc network the
                          deployment is on, and every chain value is read from it rather than configured separately.
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
                      body: "Strongly typed contract reads and writes for USDC payments, approvals, event history, and Arc wallet interactions.",
                    },
                    {
                      title: "Two wallet backends",
                      body: "One interface, two implementations: an embedded wallet the user owns, or a server-operated developer-controlled wallet. A deployment picks one, and the ~40 route handlers behind the session never learn which.",
                    },
                    {
                      title: "Solidity contracts",
                      body: "Bill registry, handle escrow and recurring tab contracts define the accounting rules that keep payments verifiable onchain.",
                    },
                    {
                      title: "Circle Gateway",
                      body: "Permissionless cross-chain USDC payments from Avalanche, Base, or Ethereum into Arc using EIP-712 burn intents and Gateway attestation.",
                    },
                    {
                      title: "CCTP",
                      body: "Native USDC burn-and-mint movement between supported source chains and Arc, underpinning the Gateway flow.",
                    },
                    {
                      title: "Settlement automation",
                      body: "Protected automation checks recurring tabs on a schedule so payers do not need to press a settle button each cycle, and nudges overdue shares on the creditor side.",
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
                      "Creates bills, records participant debts, accepts partial or full payments, batches claims and payments into one settle call, refunds a failed all-or-nothing bill, and lets splitters claim paid funds.",
                      <>
                        <code>BillCreated</code>, <code>DebtPaid</code>, <code>DebtRefunded</code>,{" "}
                        <code>FundsClaimed</code>, <code>DebtCollected</code>
                      </>,
                    ],
                    [
                      <code key="c">HandleEscrow</code>,
                      "Holds USDC against a hash of someone's handle until they sign in, releases it to the wallet they arrive with, and lets the sender reclaim it at any time before that.",
                      <>
                        <code>Deposited</code>, <code>Released</code>, <code>Reclaimed</code>
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
                <Subhead>The live Arc Testnet deployment</Subhead>
                <pre className="doc-code">{`BillSplitRegistry   0x8e30ca7f7347854629619aec68bd29d7ebedbd48
HandleEscrow        0xc29b959868828702c37811deba826da48f0e1a6d
RecurringTabFactory 0x9Cc377C957255582BCa8084a950F52e59fB0a41E
USDC                0x3600000000000000000000000000000000000000`}</pre>
                <p>
                  Every one of them is readable on the explorer, and the two addresses the app writes bills and escrow
                  deposits to are printed in the footer of every page — so what this document claims and what the running site
                  is pointed at can be compared without taking either on trust. The registry and the escrow share one
                  immutable signing key, readable from both with <code>attester()</code>.
                </p>
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
                        Provides the <code>nonReentrant</code> modifier. Every fund-moving entrypoint (<code>payDebt</code>, <code>claim</code>, <code>settle</code>, <code>refund</code>, <code>deposit</code>, <code>release</code>, <code>reclaim</code>, <code>settleTab</code>) inherits it, so a function cannot be re-entered while it executes.
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
                  <strong>off</strong> — never as &quot;settle without the job&quot;. On the creditor side, a scheduled job
                  nudges a share before its due date, escalates after it, and pulls only where the debtor granted a per-bill
                  collect mandate.
                </p>
                <p>
                  One operator duty has no user-visible counterpart: the wallet that relays{" "}
                  <a href="#no-wallet-yet">escrow releases</a> needs USDC, because Arc charges gas in USDC. If it runs dry the
                  releases stop and nothing on screen says so — deposits stay safe and reclaimable, and sign-ins keep working,
                  which is the right failure but a quiet one. It is monitored by balance, not by error.
                </p>
              </Section>

              <Section id="security">
                <ul>
                  <li>Users explicitly approve USDC spend before contracts can pull funds.</li>
                  <li>Recurring approval is constrained to the tab contract address and can be revoked by setting allowance to zero.</li>
                  <li>Recurring settlement is protected by operational controls and is not exposed as a public user action.</li>
                  <li>Every fund-moving entrypoint follows checks-effects-interactions and is guarded by the shared <code>ReentrancyGuard</code> (<code>nonReentrant</code>) module.</li>
                  <li>All USDC movement routes through the <code>SafeERC20</code> library, so a token that returns no data or <code>false</code> can never be treated as a successful transfer.</li>
                  <li>Contracts hold no privileged owner and expose no upgrade, pause, sweep, or <code>selfdestruct</code> path; funds can only ever leave to a bill&apos;s splitter, a refunded payer, a tab&apos;s immutable recipient, or an escrow deposit&apos;s recipient or depositor.</li>
                  <li>Where a payment is signed by the user&apos;s own wallet, the server compares the signed transaction against the one it prepared before broadcasting it — otherwise a user could sign anything from their own wallet and have a route mark a debt paid.</li>
                  <li>Money held for someone with no wallet is released only against a signature that names the deposit, the recipient and a deadline, and the depositor can <a href="#no-wallet-yet">reclaim</a> it unconditionally until that happens.</li>
                  <li>An address derived from a handle has no key anywhere, which is why it is only ever used to <em>file</em> a debt and never to receive money.</li>
                  <li>Sensitive operational credentials must never be exposed in browser code, screenshots, public docs, or client logs.</li>
                  <li>Contracts use custom errors and explicit checks for invalid amounts, unknown bills, unauthorized claims, expired signatures, and duplicate recurring members.</li>
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
                  Splitsy should be connected to the intended Arc contracts before users create bills or recurring tabs.
                  Contract addresses, the network itself, USDC settings, bridge support, receipt scanning, and settlement
                  automation are all managed by the operator at deployment.
                </p>
                <Subhead>What an operator decides</Subhead>
                <Table
                  head={["Setting", "What it chooses", "What its absence means"]}
                  rows={[
                    [
                      "Network",
                      <>
                        Arc Testnet or Arc mainnet. Chain id, RPC, explorer, USDC and the Gateway contracts all follow from it.
                      </>,
                      "Testnet — the network where being wrong costs nothing.",
                    ],
                    [
                      "Contract addresses",
                      <>
                        Which registry, escrow and tab factory this deployment reads and writes. Each network has its own set,
                        so both can be configured at once and one setting decides which is live.
                      </>,
                      <>
                        The feature refuses rather than guessing. A missing escrow address means money is never sent to a
                        stranger, not sent somewhere else.
                      </>,
                    ],
                    [
                      "Wallet backend",
                      "Whether sign-in produces an embedded wallet the user owns or a server-operated one.",
                      "The server-operated wallet — the older path, which is what a misspelled value lands on.",
                    ],
                    [
                      "Reputation registries",
                      <>
                        Whether <a href="#payment-reputation">payment reputation</a> is recorded at all.
                      </>,
                      "Off, and silently: payments succeed and nothing is minted or scored.",
                    ],
                    [
                      "Agent economy",
                      <>
                        Whether <a href="#autopay-agents">autopay</a> runs as ERC-8183 jobs.
                      </>,
                      <>
                        Autopay off — never &quot;settle without the job&quot;.
                      </>,
                    ],
                  ]}
                />
                <p>
                  Every browser-visible setting is frozen into the build that saw it, so changing one needs a redeploy rather
                  than a saved value. That cuts both ways and is worth stating: a setting left <em>unset</em> keeps a live
                  read, so the age of a build is never what keeps a feature off — only the absence of the value is.
                </p>
                <Rows
                  rows={[
                    {
                      title: "For users",
                      body: (
                        <>
                          Use a compatible browser wallet or sign in for one, stay on the supported Arc network, keep enough USDC for
                          payments and gas, and review every wallet prompt before signing.
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
