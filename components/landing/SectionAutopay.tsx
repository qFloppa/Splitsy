"use client";

import { useReveal } from "./useReveal";

// Act two of the agent chapter. Deliberately still: DemoStage already pins the
// scroll and AgentStage already autoplays a looping transcript, so a third
// timeline would compete with both. This section only enters.
//
// Two claims here are load-bearing and must not soften into marketing:
//   1. Funding is a plain transfer, never an approval. The balance IS the
//      ceiling, which is why the page can promise a hard limit at all.
//   2. In Funded mode the AutopayMandate caps are NOT in the path — the rules
//      are checked off-chain before the agent spends. Nothing below says
//      "enforced by a contract", because that would not be true.
// See docs/agent-economy.md#funding and #the-two-money-modes.

const ROUTES = [
  { label: "A connected browser wallet", detail: "signs a USDC transfer on Arc" },
  { label: "Your Splitsy wallet", detail: "the same transfer, behind your PIN" },
  { label: "Anywhere else", detail: "it is just an address, so send it USDC" },
];

const ROLES = [
  { role: "client", who: "Your agent", note: "posts the job, escrows the fee" },
  { role: "provider", who: "The Settler", note: "does the work, proves what it did" },
  { role: "evaluator", who: "The Auditor", note: "paid to say no" },
];

const STEPS = [
  { call: "createJob", signer: "your agent" },
  { call: "setBudget", signer: "the Settler prices its own work" },
  { call: "fund", signer: "0.01 USDC into escrow" },
  { call: "payDebtFor", signer: "the only step that moves bill money" },
  { call: "submit", signer: "keccak256(settlement tx)" },
  { call: "complete", signer: "the Auditor, only when paid ≥ owed" },
];

const FACTS = [
  {
    title: "Six transactions per settled share",
    body: "Per share, not per bill. A four-person bill where everyone autopays is four independent jobs.",
  },
  {
    title: "A refusal costs nothing",
    body: "Your rules run before the job is opened, so a bill your agent declines sends no transaction at all.",
  },
  {
    title: "The reputation is yours",
    body: "payDebtFor pulls from the agent but credits you. The DebtPaid event names you as the payer.",
  },
];

export function SectionAutopay() {
  const ref = useReveal<HTMLElement>("top 76%");

  return (
    <section aria-labelledby="autopay-heading" className="bill-poster scroll-mt-24" id="autopay" ref={ref}>
      <div className="lp-measure">
        <div className="bill-poster-head">
          <span className="settle-label" data-reveal="item">
            <span className="lp-step">03</span> Agents that pay
          </span>
          <span className="bill-poster-fact" data-reveal="item">
            one agent per account · its own USDC on Arc
          </span>
        </div>
        <h2 className="lp-display-lg mt-4 max-w-4xl" data-reveal="lead" id="autopay-heading">
          Fund an agent
          <br />
          <span className="lp-headline-accent">It settles your share</span>
        </h2>
        <p className="lp-lede mt-5 max-w-2xl" data-reveal="lead">
          A bill raised against you can be settled without you opening the app. It spends only what you
          have sent it, only under ceilings you set, and every settlement it makes is a public job a second
          agent has to sign off before any fee is released.
        </p>

        <div className="bill-poster-body grid gap-x-[clamp(2rem,1rem+4vw,6rem)] gap-y-12 lg:grid-cols-2">
          {/* LEFT · the balance is the ceiling. The top-up is the section's hero
              figure, because the whole argument is that this number is the limit —
              not a rule, not a contract, this number. */}
          <div>
            <span className="settle-label" data-reveal="item">
              You fund it first
            </span>
            <div className="bill-cell mt-4" data-reveal="item">
              <span className="settle-label">Suggested first top-up</span>
              {/* ponytail: no count-up on this one. A tween that is mid-flight,
                  interrupted, or caught in a screenshot shows a figure that is
                  not the figure — and $0.00 under "suggested first top-up" is a
                  wrong claim about money, not a missing flourish. The netting
                  section counts a transaction count, where it cannot mislead. */}
              <div className="bill-figure">
                <span className="bill-currency">$</span>
                2.00
              </div>
              <div className="bill-cell-rule lp-rule" data-rule />
              <p className="lp-row-proof mt-2">0x7a41…4c1f · send more if the shares you expect are larger</p>
            </div>

            <div className="lp-rows mt-8">
              {ROUTES.map((route) => (
                <div className="lp-row grid-cols-[minmax(0,1fr)_auto]" data-reveal="item" key={route.label}>
                  <span className="text-[0.95rem] text-[var(--pay-poster-fg)]">{route.label}</span>
                  <span className="lp-row-body">{route.detail}</span>
                </div>
              ))}
            </div>

            <p className="lp-note mt-8" data-reveal="item">
              <b>
                Funding is a transfer, never an approval.
              </b>{" "}
              An agent holding 5 USDC can never spend 6. Whatever any rule says, it has nothing else to
              draw on. Until it holds USDC every bill is skipped, no job is opened, and nothing is spent.
            </p>
          </div>

          {/* RIGHT · nobody grades their own work */}
          <div>
            <span className="settle-label" data-reveal="item">
              Then it has to prove it
            </span>

            <div className="bill-poster-rail">
              {ROLES.map((role) => (
                <div className="bill-cell" data-reveal="item" key={role.role}>
                  <span className="settle-label">{role.role}</span>
                  <div className="bill-figure-sm">{role.who}</div>
                  <div className="bill-cell-rule lp-rule" data-rule />
                  <p className="lp-row-body mt-2">{role.note}</p>
                </div>
              ))}
            </div>
            <p className="bill-options-hint" data-reveal="item">
              Three distinct wallets, so the party that gets paid is never the party that decides it
              earned it.
            </p>

            <ol className="lp-rows mt-8 list-none p-0">
              {/* Rows stack on narrow columns rather than truncating: "the only
                  step that moves bill money" is the point of the row, not a label. */}
              {STEPS.map((step, index) => (
                <li className="lp-row grid-cols-[auto_minmax(0,1fr)] sm:grid-cols-[auto_auto_minmax(0,1fr)]" data-reveal="item" key={step.call}>
                  <span className="lp-step-num">{String(index + 1).padStart(2, "0")}</span>
                  <span className="mono text-[0.9rem] text-[var(--pay-poster-fg)]">{step.call}</span>
                  <span className="lp-row-body col-start-2 sm:col-start-3 sm:text-right">{step.signer}</span>
                </li>
              ))}
            </ol>

            <p className="lp-note mt-8" data-reveal="item">
              The escrow only ever holds the fee. Your share is never inside it. The Auditor reads the
              registry itself, and if the debt is not really settled it does not complete: the job expires
              an hour later and the Settler is not paid for work it did not do.
            </p>
          </div>
        </div>

        <div className="lp-rows mt-12">
          {FACTS.map((fact) => (
            <div className="lp-row grid-cols-1 md:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]" data-reveal="item" key={fact.title}>
              <span className="text-[1.05rem] text-[var(--pay-poster-fg)]">{fact.title}</span>
              <span className="lp-row-body">{fact.body}</span>
            </div>
          ))}
        </div>

        <p className="bill-options-hint" data-reveal="item">
          Your ceilings (per bill, per day, an allowed-creator list, a creator score floor, a
          verified-hash requirement and a paid review of the bill&apos;s contents) are checked before your
          agent spends rather than enforced by a contract, so the hard limit is the balance above. The
          address and figures here are illustrative; your own are on the settlement-agents panel.
        </p>
      </div>
    </section>
  );
}
