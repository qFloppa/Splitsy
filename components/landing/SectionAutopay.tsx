"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";
import { Coins, Gavel, Globe, HandCoins, Landmark, ShieldCheck, WalletCards } from "lucide-react";

// Act two of the agent chapter. Deliberately static: DemoStage already pins the
// scroll and AgentStage already autoplays a looping transcript, so a third
// timeline would compete with both. This is SectionTreasury's scroll-reveal
// pattern — no pin, no loop.
//
// Two claims here are load-bearing and must not soften into marketing:
//   1. Funding is a plain transfer, never an approval. The balance IS the
//      ceiling, which is why the page can promise a hard limit at all.
//   2. In Funded mode the AutopayMandate caps are NOT in the path — the rules
//      are checked off-chain before the agent spends. Nothing below says
//      "enforced by a contract", because that would not be true.
// See docs/agent-economy.md#funding and #the-two-money-modes.

const ROUTES = [
  {
    icon: <WalletCards size={15} />,
    label: "A connected browser wallet",
    detail: "signs a USDC transfer on Arc",
  },
  {
    icon: <Landmark size={15} />,
    label: "Your Splitsy wallet",
    detail: "the same transfer, behind your PIN",
  },
  {
    icon: <Globe size={15} />,
    label: "Anywhere else",
    detail: "it is just an address, so send it USDC",
  },
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
    icon: <Coins size={18} />,
    title: "Six transactions per settled share",
    body: "Per share, not per bill. A four-person bill where everyone autopays is four independent jobs.",
  },
  {
    icon: <ShieldCheck size={18} />,
    title: "A refusal costs nothing",
    body: "Your rules run before the job is opened, so a bill your agent declines sends no transaction at all.",
  },
  {
    icon: <HandCoins size={18} />,
    title: "The reputation is yours",
    body: "payDebtFor pulls from the agent but credits you. The DebtPaid event names you as the payer.",
  },
];

export function SectionAutopay() {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const root = rootRef.current;
    if (!root) return;

    const ctx = gsap.context(() => {
      gsap.from("[data-autopay-heading]", {
        y: 26,
        autoAlpha: 0,
        duration: 0.8,
        ease: "expo.out",
        scrollTrigger: { trigger: root, start: "top 74%" },
      });
      gsap.from("[data-autopay-card]", {
        y: 24,
        autoAlpha: 0,
        duration: 0.7,
        ease: "expo.out",
        stagger: 0.12,
        scrollTrigger: { trigger: root, start: "top 62%" },
      });
      gsap.from("[data-autopay-step]", {
        x: -10,
        autoAlpha: 0,
        duration: 0.45,
        ease: "power2.out",
        stagger: 0.06,
        scrollTrigger: { trigger: root, start: "top 46%" },
      });
      gsap.from("[data-autopay-fact]", {
        y: 20,
        autoAlpha: 0,
        duration: 0.6,
        ease: "expo.out",
        stagger: 0.1,
        scrollTrigger: { trigger: root, start: "top 30%" },
      });
    }, root);

    return () => ctx.revert();
  }, []);

  return (
    <section
      aria-labelledby="autopay-heading"
      className="mx-auto w-full max-w-[80rem] scroll-mt-24 px-4 pt-[var(--lp-section-y)] sm:px-6 lg:px-8"
      id="autopay"
      ref={rootRef}
    >
      <p
        className="text-[0.62rem] font-extrabold uppercase tracking-[0.08em] text-[var(--text-muted)]"
        data-autopay-heading
      >
        Act two · agents that pay
      </p>
      <h2 className="lp-display-lg mt-3 max-w-3xl" data-autopay-heading id="autopay-heading">
        Fund an agent.
        <br />
        <span className="lp-headline-accent">It settles your share.</span>
      </h2>
      <p className="lp-lede mt-5 max-w-2xl" data-autopay-heading>
        A bill raised against you can be settled without you opening the app. The agent is yours: one per
        account, holding its own USDC on Arc. It spends only what you have sent it, only under ceilings you
        set, and every settlement it makes is a public job a second agent has to sign off before any fee is
        released.
      </p>

      <div className="mt-12 grid grid-cols-1 items-stretch gap-3 lg:grid-cols-2">
        {/* LEFT · the balance is the ceiling */}
        <div
          className="flex flex-col rounded-[calc(var(--radius)+4px)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-soft)] backdrop-blur-xl sm:p-6"
          data-autopay-card
        >
          <p className="text-[0.62rem] font-extrabold uppercase tracking-[0.08em] text-[var(--text-muted)]">
            You fund it first
          </p>

          <div className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-strong)] p-4">
            <p className="flex items-center justify-between gap-3 text-xs text-[var(--text-muted)]">
              <span className="font-semibold text-[var(--text-soft)]">Your agent</span>
              <span className="mono truncate">0x7a41…4c1f</span>
            </p>
            <p className="amount-text mt-3 text-3xl font-bold text-[var(--text)] sm:text-4xl">2.00 USDC</p>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              A suggested first top-up. Send more if the shares you expect are larger.
            </p>
          </div>

          <ul className="mt-4 list-none space-y-2 p-0">
            {ROUTES.map((route) => (
              <li className="flex items-center gap-3" key={route.label}>
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface-strong)] text-[var(--text-soft)]">
                  {route.icon}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-bold text-[var(--text)]">{route.label}</span>
                  <span className="block truncate text-xs text-[var(--text-muted)]">{route.detail}</span>
                </span>
              </li>
            ))}
          </ul>

          <p className="mt-auto pt-5 text-sm text-[var(--text-muted)]">
            <span className="font-bold text-[var(--text)]">Funding is a transfer, never an approval.</span>{" "}
            An agent holding 5 USDC can never spend 6. Whatever any rule says, it has nothing else to draw
            on. Until it holds USDC every bill is skipped, no job is opened, and nothing is spent.
          </p>
        </div>

        {/* RIGHT · nobody grades their own work */}
        <div
          className="flex flex-col rounded-[calc(var(--radius)+4px)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-soft)] backdrop-blur-xl sm:p-6"
          data-autopay-card
        >
          <p className="text-[0.62rem] font-extrabold uppercase tracking-[0.08em] text-[var(--text-muted)]">
            Then it has to prove it
          </p>

          <ul className="mt-4 grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-3">
            {ROLES.map((role) => (
              <li
                className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-strong)] px-3 py-2.5"
                key={role.role}
              >
                <span className="mono block truncate text-[0.62rem] uppercase tracking-[0.06em] text-[var(--accent)]">
                  {role.role}
                </span>
                <span className="mt-1 block truncate text-sm font-bold text-[var(--text)]">{role.who}</span>
                <span className="mt-0.5 block text-xs text-[var(--text-muted)]">{role.note}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-[var(--text-muted)]">
            Three distinct wallets, so the party that gets paid is never the party that decides it earned it.
          </p>

          <ol className="mono mt-5 list-none space-y-0 p-0 text-xs">
            {/* Rows stack on narrow cards rather than truncating: "the only step
                that moves bill money" is the point of the row, not a label. */}
            {STEPS.map((step, index) => (
              <li
                className="flex flex-col gap-0.5 py-1.5 sm:flex-row sm:items-baseline sm:gap-3"
                data-autopay-step
                key={step.call}
              >
                <span className="flex items-baseline gap-3">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-[var(--border)] text-[0.6rem] font-bold text-[var(--text-muted)]">
                    {index + 1}
                  </span>
                  <span className="font-semibold text-[var(--text)]">{step.call}</span>
                </span>
                <span className="pl-8 text-[var(--text-muted)] sm:flex-1 sm:pl-0 sm:text-right">
                  {step.signer}
                </span>
              </li>
            ))}
          </ol>

          <p className="mt-auto pt-5 text-sm text-[var(--text-muted)]">
            <Gavel className="mr-1.5 inline align-[-2px] text-[var(--text-soft)]" size={15} />
            The escrow only ever holds the fee. Your share is never inside it. The Auditor reads the
            registry itself, and if the debt is not really settled it does not complete: the job expires an
            hour later and the Settler is not paid for work it did not do.
          </p>
        </div>
      </div>

      <ul className="mt-3 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-3">
        {FACTS.map((fact) => (
          <li
            className="rounded-[calc(var(--radius)+4px)] border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow-soft)] backdrop-blur-xl"
            data-autopay-fact
            key={fact.title}
          >
            <span className="text-[var(--text-soft)]">{fact.icon}</span>
            <p className="mt-3 text-sm font-bold text-[var(--text)]">{fact.title}</p>
            <p className="mt-1 text-sm text-[var(--text-muted)]">{fact.body}</p>
          </li>
        ))}
      </ul>

      <p className="mt-6 max-w-3xl text-xs text-[var(--text-muted)]">
        Your ceilings (per bill, per day, an allowed-creator list, a creator score floor, a verified-hash
        requirement and a paid review of the bill&apos;s contents) are checked before your agent spends
        rather than enforced by a contract, so the hard limit is the balance above. The address and figures
        on this card are illustrative; your own are on the settlement-agents panel.
      </p>
    </section>
  );
}
