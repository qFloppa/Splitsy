"use client";

import { useEffect } from "react";
import Link from "next/link";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import { ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";

import type { SiteContract } from "@/lib/site-contracts";
import { ARC } from "@/lib/arc-chain";
import { Nav } from "./Nav";
import { useReveal } from "./useReveal";

gsap.registerPlugin(ScrollTrigger);

// The trust page.
//
// WHY IT IS NOT THE /docs SECURITY SECTION. That one is sixteen bullets of
// accurate engineering written for somebody who already knows what a reentrancy
// guard is, buried at §18 of a reference document. It stays exactly as it is —
// it is the right page for that reader. This is for the other reader: somebody
// deciding whether to let Splitsy near their money, who will not look up
// "checks-effects-interactions" to find out whether they are safe. Nothing here
// is a new claim. Every sentence is one of those bullets, rewritten so it can be
// understood without a glossary, and §4 is the part a bullet list cannot do at
// all: what is NOT safe, said out loud.
//
// The construction is app/docs/page.tsx's, not the landing's: .lp-paper
// doc-paper for the ground, .doc-head for the opening, and each section a
// .bill-poster.doc-section that prints its own part and ordinal. That buys the
// prose styling for <p>, <ul>, <strong> and <code> for free, which is what a
// page of sentences needs, and it means the two security pages are visibly the
// same document family. No new CSS was written for this route.
//
// What it takes from the landing instead is the motion: useReveal, so sections
// print rather than appear. /docs deliberately has none, but only because its
// search wraps hits in <mark> and a document shipped at autoAlpha: 0 would
// highlight things you cannot see. There is no search here.

const GITHUB = "https://github.com/qFloppa/Splitsy";
const CONTRACTS_SRC = `${GITHUB}/tree/main/contracts`;

/**
 * Which network this build is for, which decides the two places on the page where
 * "is this real money?" is the whole answer.
 *
 * It must switch with the deployment and not be edited by hand, because the
 * testnet wording is a RISK DISCLOSURE in one direction and a FALSE REASSURANCE in
 * the other: "no real funds" left standing on a mainnet build tells somebody their
 * money is play money while it is not. So it reads the same switch every other
 * network-dependent fact on the site reads (lib/arc-chain.ts), inlined at build
 * time — flip NEXT_PUBLIC_ARC_NETWORK in Vercel, redeploy, and both sentences
 * change with the addresses in the footer rather than lagging behind them.
 *
 * Deliberately NOT a prop: it is a property of the build, not of this render, and
 * threading it would let a caller pass a network the rest of the site disagrees
 * with. HomeClient.tsx already imports ARC into a client component for the same
 * reason.
 */
const ON_MAINNET = ARC.network === "mainnet";

/**
 * The outline, and the only place it is declared — the construction
 * app/docs/sections.ts uses, shrunk to what five sections need. The ordinal is
 * the array index, so inserting a section renumbers the ones after it and the
 * head cannot print a number the order disagrees with.
 *
 * Ids are load-bearing: they are what the nav, the footer and /docs §18 link
 * into. A section may be retitled without touching its id.
 */
const SECTIONS = [
  { id: "no-owner", part: "What cannot happen", title: "Nobody owns these contracts" },
  { id: "waiting-money", part: "What cannot happen", title: "Money held for someone who hasn't joined yet" },
  { id: "your-approval", part: "What cannot happen", title: "Nothing moves without your approval" },
  { id: "could-go-wrong", part: "Being straight with you", title: "What could still go wrong" },
  { id: "check-yourself", part: "Being straight with you", title: "Check all of this yourself" },
] as const;

/**
 * A section, which looks its own part and ordinal up rather than being handed
 * them. Each one owns its reveal: the hook needs a root to scope its selectors
 * to, and a section is exactly that root.
 */
function Section({ children, id }: { children: ReactNode; id: string }) {
  const index = SECTIONS.findIndex((entry) => entry.id === id);
  const entry = SECTIONS[index]!;
  const ref = useReveal<HTMLElement>("top 82%");

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="bill-poster doc-section"
      data-last={index === SECTIONS.length - 1 ? "" : undefined}
      id={id}
      ref={ref}
    >
      <div className="bill-poster-head">
        <span className="settle-label" data-reveal="item">
          {entry.part}
        </span>
      </div>
      <h2 className="bill-section-title" data-reveal="lead" id={`${id}-title`}>
        <span className="bill-section-index">{String(index + 1).padStart(2, "0")}</span> {entry.title}
      </h2>
      {children}
    </section>
  );
}

/** A labelled point, one of a set. .doc-row, as /docs sets its pairs. */
function Rows({ rows }: { rows: { title: string; body: ReactNode }[] }) {
  const half = Math.ceil(rows.length / 2);

  return (
    <div className="doc-rows" data-cols="2">
      {[rows.slice(0, half), rows.slice(half)].map((column, index) =>
        column.length === 0 ? null : (
          // role="list" survives list-style: none, which Safari otherwise takes
          // as permission to drop the list semantics entirely.
          <ul className="lp-rows m-0 list-none p-0" key={index} role="list">
            {column.map((row) => (
              <li className="lp-row doc-row" data-reveal="item" key={row.title}>
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

function Subhead({ children }: { children: ReactNode }) {
  return (
    <h3 className="bill-subhead doc-subhead" data-reveal="item">
      <span>{children}</span>
    </h3>
  );
}

function Note({ children, title }: { children: ReactNode; title: string }) {
  return (
    <aside className="doc-note" data-reveal="item">
      <span className="settle-label">{title}</span>
      <p>{children}</p>
    </aside>
  );
}

export type SecurityPageProps = {
  /** The deployment's own contracts, for §05. Empty where none is configured. */
  contracts: SiteContract[];
  /** How long a deposit stays payable, e.g. "30 days". Null if the read failed. */
  holdWindow: string | null;
  /** The rolling 24h release ceiling, e.g. "10,000 USDC". Null if the read failed. */
  dailyCeiling: string | null;
};

export function SecurityPage({ contracts, holdWindow, dailyCeiling }: SecurityPageProps) {
  // ponytail: third copy of this effect (LandingPage, DevelopersPage, here).
  // Extract to a useLenis hook next time a fourth page wants it — at three the
  // extraction is still smaller than the risk of touching two live pages.
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const lenis = new Lenis({ lerp: 0.12, wheelMultiplier: 1 });
    lenis.on("scroll", ScrollTrigger.update);
    const tick = (time: number) => lenis.raf(time * 1000);
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);

    return () => {
      gsap.ticker.remove(tick);
      lenis.destroy();
    };
  }, []);

  const escrow = contracts.find((contract) => contract.label === "HandleEscrow");

  return (
    <div className="lp-paper doc-paper">
      <Nav />
      <main id="main">
        {/* ── the head ──────────────────────────────────────────────────────── */}
        <section aria-labelledby="security-title" className="lp-measure doc-head">
          <p className="settle-label">Safety</p>
          <h1 className="lp-display-lg mt-4 max-w-4xl" id="security-title">
            Nobody can move your money. <span className="lp-headline-accent">Not even us.</span>
          </h1>
          <p className="lp-lede mt-6 max-w-2xl">
            Splitsy runs on small programs published on a public network. They were published once and cannot be
            edited — not by us, not by anyone who takes over Splitsy, not by anyone who breaks into it. This page
            explains what that actually protects you from, in plain words, and then tells you the things it
            doesn&apos;t.
          </p>

          {/* The four questions somebody asks before reading a word of the rest.
              A <dl>, because four labelled facts are a definition list and the
              one thing here a screen reader can announce as pairs. */}
          <dl className="bill-contents doc-glance">
            {[
              { label: "Who can change the rules", value: "Nobody. There is no owner." },
              { label: "Who can freeze your funds", value: "Nobody. There is no pause button." },
              { label: "Who can empty the contracts", value: "Nobody. There is no withdraw-all." },
              {
                label: "Network",
                value: ON_MAINNET ? "Arc · real USDC, real money" : "Arc Testnet · test USDC only, no real funds",
              },
            ].map((fact) => (
              <div className="bill-cell" key={fact.label}>
                <dt className="settle-label">{fact.label}</dt>
                <dd className="bill-contents-label">{fact.value}</dd>
                <div className="bill-cell-rule" />
              </div>
            ))}
          </dl>
        </section>

        <div className="lp-measure">
          <article>
            {/* ── 01 ─────────────────────────────────────────────────────────── */}
            <Section id="no-owner">
              <p>
                Most apps that hold money have an administrator — someone with a master password who can freeze an
                account, reverse a payment, or move the money somewhere else. Usually that is a feature. It is also
                the single thing you are trusting when you hand money to a company: that nobody abuses the master
                password, and that nobody steals it.
              </p>
              <p>
                Splitsy&apos;s contracts have no administrator. Not a locked-away one, not a
                committee-controlled one — the ability does not exist in the program. There is no function that
                changes the rules, so there is no key that could call it. This is checkable rather than promised:
                the code is public, and the three things below are absences you can confirm for yourself in §05.
              </p>
              <Rows
                rows={[
                  {
                    title: "No owner, no admin",
                    body: (
                      <>
                        Nothing in these contracts asks <em>who is calling</em> and treats one address as special.
                        A Splitsy employee has exactly the powers you do.
                      </>
                    ),
                  },
                  {
                    title: "No upgrade",
                    body: (
                      <>
                        The rules cannot be swapped out later. What the contract did the day it was published is
                        what it will do forever. Changing anything means publishing a different contract at a
                        different address, in public.
                      </>
                    ),
                  },
                  {
                    title: "No pause, no freeze",
                    body: (
                      <>
                        There is no stop button, because a stop button is something a person has to be allowed to
                        press. Your ability to get your money out does not depend on Splitsy staying online, or
                        staying in business.
                      </>
                    ),
                  },
                  {
                    title: "No way to empty the pot",
                    body: (
                      <>
                        There is no &quot;withdraw everything&quot; and no way to destroy a contract while holding
                        funds. Money is only allowed to leave along the routes written into the program: back to
                        whoever put it in, or on to the person they named. There is no third door.
                      </>
                    ),
                  },
                ]}
              />
              <Note title="The same fact, read from the other side">
                Because there is no administrator, there is also nobody to appeal to. If you pay the wrong person,
                Splitsy cannot reverse it — not because we won&apos;t, because the ability does not exist. That is
                the real trade, and you should know it before you send anything rather than after. Check the name
                and the amount in your wallet&apos;s own prompt every time.
              </Note>
            </Section>

            {/* ── 02 ─────────────────────────────────────────────────────────── */}
            <Section id="waiting-money">
              <p>
                You can pay someone who has never heard of Splitsy — you just type their email address or handle.
                But a person who hasn&apos;t signed in yet has no wallet, so there is nowhere to send the money.
                It waits in a contract called <code>HandleEscrow</code> until their first sign-in creates one.
              </p>
              <p>
                This is the part people are rightly suspicious of, because for a while the money is in neither
                person&apos;s hands. So here is the whole arrangement. Four things are true while it waits, and
                none of them require trusting Splitsy to behave.
              </p>

              <Subhead>You can take it back, at any moment</Subhead>
              <p>
                One click, any time before it is collected. You need nobody&apos;s permission and there is no
                waiting period, no review, and no deadline after which you lose the right. The contract asks a
                single question — are you the person who put this money in? — and if the answer is yes it sends it
                straight back. Nothing can stand in the way of that: not Splitsy, not a server being down, not
                even someone who has stolen Splitsy&apos;s keys. It is the one door that is never allowed to be
                locked, which is exactly why it has no limits of any kind on it.
              </p>

              <Subhead>Paying it out needs a note that fits one deposit only</Subhead>
              <p>
                When the recipient signs in, Splitsy signs a short note that says, in effect:{" "}
                <em>deposit number 41 goes to this one wallet, and this note stops working at this time.</em> The
                contract will not pay out without it, and it checks every part. The note cannot be edited, cannot
                be pointed at a different wallet, and cannot be used twice — the moment it works, the deposit is
                erased from the contract, so a second attempt finds nothing there and fails.
              </p>

              <Subhead>Every deposit runs out</Subhead>
              <p>
                {holdWindow ? (
                  <>
                    <strong>{holdWindow}</strong> after you pay in, the pay-out door closes permanently.
                  </>
                ) : (
                  <>After a fixed window set when the contract was published, the pay-out door closes permanently.</>
                )}{" "}
                From then on the only direction the money can move is back to you. In practice Splitsy returns
                unclaimed deposits long before that — but the deadline is written into the contract rather than
                into our habits, so it holds even if Splitsy stops running entirely. The point of it is that the
                amount sitting in here can never quietly pile up over years.
              </p>

              <Subhead>There is a hard ceiling on what can leave in a day</Subhead>
              <p>
                {dailyCeiling ? (
                  <>
                    The contract will not pay out more than <strong>{dailyCeiling}</strong> in any twenty-four
                    hours.
                  </>
                ) : (
                  <>The contract will not pay out more than a fixed amount in any twenty-four hours.</>
                )}{" "}
                This is not a policy we follow — it is a wall the program enforces, and it applies to a genuine
                pay-out and a fraudulent one identically. If the worst case in §04 ever happened, this is the
                thing that would hold the damage to one day&apos;s worth, in public, while everyone else took
                their money back.
              </p>
              <p>
                A deposit larger than that ceiling is refused when you try to make it, rather than accepted and
                then stuck. Better to be told no at the start than to find out later with the money already in.
              </p>
            </Section>

            {/* ── 03 ─────────────────────────────────────────────────────────── */}
            <Section id="your-approval">
              <p>
                No Splitsy contract can reach into your wallet and help itself. Before any of them can move a
                single cent, you have to approve it, and the approval happens in your wallet&apos;s own prompt —
                a screen Splitsy does not control and cannot fake. If you never approve anything, nothing can
                ever be taken.
              </p>
              <Rows
                rows={[
                  {
                    title: "An approval names one contract",
                    body: (
                      <>
                        You are not giving &quot;Splitsy&quot; permission. You are giving one specific program
                        permission, for an amount you can see. Nothing else inherits it.
                      </>
                    ),
                  },
                  {
                    title: "You can cancel it",
                    body: (
                      <>
                        Set the approval back to zero at any time and the permission is gone. You do not need
                        Splitsy&apos;s cooperation, or Splitsy&apos;s existence, to do it.
                      </>
                    ),
                  },
                  {
                    title: "A recurring tab can only ever pay one address",
                    body: (
                      <>
                        The address that gets paid is fixed when the tab is created and cannot be changed
                        afterwards. A compromised Splitsy could not redirect your rent to itself.
                      </>
                    ),
                  },
                  {
                    title: "What you sign is what gets sent",
                    body: (
                      <>
                        When your own wallet signs a payment, our server compares the signed transaction against
                        the one it asked you to sign, and refuses to broadcast if they differ. Without that check,
                        someone could sign anything at all from their own wallet and have Splitsy record a debt as
                        settled.
                      </>
                    ),
                  },
                  {
                    title: "An automatic payer spends only its own pocket money",
                    body: (
                      <>
                        If you set up an agent to pay a bill for you, it spends from a balance you transferred to
                        it. Splitsy holds no permission on your own wallet on its behalf — so that balance is a
                        hard ceiling no rule, bug, or broken server can go past.
                      </>
                    ),
                  },
                  {
                    title: "Nobody sees other people's debts",
                    body: (
                      <>
                        When you open a bill you are shown your own share. Amounts are on a public network and so
                        are checkable by design, but the app does not put other people&apos;s business in front of
                        you.
                      </>
                    ),
                  },
                ]}
              />
            </Section>

            {/* ── 04 ─────────────────────────────────────────────────────────── */}
            <Section id="could-go-wrong">
              <p>
                Everything above is what the contracts guarantee. A security page that stops there is a sales
                page. Here is the rest of it — the weak points we know about, described as plainly as the strong
                ones, because you cannot judge the first three sections without them.
              </p>

              <Subhead>The one key we hold, and exactly what it can reach</Subhead>
              <p>
                Somebody has to decide which wallet belongs to <code>alex@example.com</code>, and that somebody is
                Splitsy. We hold a single key whose only job is to vouch for that link. It is the one piece of
                trust in the whole system that is placed in us rather than in the code.
              </p>
              <p>
                Its reach is deliberately narrow: it can send a deposit that is still waiting in escrow to the
                wallet it names, and that is the whole of what it can do. The four limits below are what keep it
                there, and each one is enforced by the contract itself rather than by us noticing anything:
              </p>
              <Rows
                rows={[
                  {
                    title: "It cannot touch your wallet",
                    body: (
                      <>
                        The key has no power over your own balance, your approvals, or anything you have not
                        already sent into escrow. It can only misdirect money the escrow is already holding.
                      </>
                    ),
                  },
                  {
                    title: "It cannot claw anything back",
                    body: <>Payments that have already arrived somewhere are finished and out of reach.</>,
                  },
                  {
                    title: "It cannot beat you to the exit",
                    body: (
                      <>
                        Taking your deposit back has no limits and needs nobody&apos;s approval. Anyone who
                        reclaims gets their money, and that is the actual recovery plan.
                      </>
                    ),
                  },
                  {
                    title: "It cannot exceed the two walls",
                    body: (
                      <>
                        The daily ceiling and the expiry in §02 are not permission checks, so a stolen signature
                        meets them exactly as a real one does. That is the whole reason they exist.
                      </>
                    ),
                  },
                ]}
              />
              <p>
                Worth stating plainly: the key cannot be swapped out, because swapping it would need an owner, and
                an owner is the thing §01 refused. So the recovery path is the one you already have — reclaim your
                deposits, and we publish a fresh contract. We would rather say that than imply a safety net that
                isn&apos;t there. The planned improvement is to move the key inside sealed hardware so that not
                even we can read it, which changes where the key lives and nothing else.
              </p>

              <Subhead>The rest of the list</Subhead>
              <Rows
                rows={[
                  {
                    title: "No outside audit yet",
                    body: (
                      <>
                        The contracts have extensive tests of their own and are checked by automated analysis
                        tools, but no independent security firm has reviewed them. Treat them accordingly.
                      </>
                    ),
                  },
                  {
                    title: "There is no undo",
                    body: (
                      <>
                        No pause, no rescue, no reversing a payment sent to the wrong person. Read §01 again if
                        that matters to you — it is the price of the thing that makes the rest safe.
                      </>
                    ),
                  },
                  {
                    title: "An email address is not a wallet",
                    body: (
                      <>
                        To write down a debt against someone who hasn&apos;t joined, we turn their handle into an
                        address. Nobody holds the key to that address — it does not have one. So it is used only
                        to <em>record</em> what is owed, never to receive money. Money goes to the escrow in §02
                        instead.
                      </>
                    ),
                  },
                  {
                    title: "Receipt scanning guesses",
                    body: (
                      <>
                        The scanner reads a photo and works out the items. It gets things wrong. Check the numbers
                        before you send a split — it is a time-saver, not an accountant.
                      </>
                    ),
                  },
                  {
                    title: "Your wallet is still yours to protect",
                    body: (
                      <>
                        Nothing here defends you against approving a payment you did not read, or against losing
                        access to your own wallet. Read every prompt before you confirm it.
                      </>
                    ),
                  },
                  {
                    title: "Bridging depends on others",
                    body: (
                      <>
                        Moving USDC in from another network relies on your wallet signing each step and on
                        Circle&apos;s own systems confirming it. Those parts are outside Splitsy.
                      </>
                    ),
                  },
                ]}
              />
              <Note title="And the biggest one">
                {ON_MAINNET ? (
                  <>
                    Splitsy runs on <strong>Arc</strong> with real USDC. The money is real, so the limits above are
                    what stands between a mistake and a loss — and nobody, us included, can reverse one for you.
                    Read the full <Link href="/disclaimer">disclaimer and acknowledgments</Link> before you rely on
                    any of it.
                  </>
                ) : (
                  <>
                    Splitsy runs on <strong>Arc Testnet</strong> using test USDC. It is not real money, and today
                    nothing on this site is at stake. Read the full{" "}
                    <Link href="/disclaimer">disclaimer and acknowledgments</Link> before treating any of it as
                    more than an experiment.
                  </>
                )}
              </Note>
            </Section>

            {/* ── 05 ─────────────────────────────────────────────────────────── */}
            <Section id="check-yourself">
              <p>
                None of this needs taking on faith, and you do not have to be a programmer to check the parts that
                matter most. Every claim above is either in the code, which is public, or on the network, which
                anyone can read.
              </p>

              {contracts.length > 0 && (
                <>
                  <Subhead>The contracts this site is actually using</Subhead>
                  <p>
                    These are read from the running configuration, not typed into this page, so they cannot drift
                    from what the app really writes to. Open one and you can see every payment it has ever made.
                  </p>
                  <ul className="lp-rows m-0 list-none p-0" role="list">
                    {contracts.map((contract) => (
                      <li key={contract.label}>
                        <a
                          className="lp-row doc-row"
                          data-reveal="item"
                          href={contract.url}
                          rel="noopener noreferrer"
                          target="_blank"
                          title={contract.address}
                        >
                          <span className="doc-row-title">{contract.label}</span>
                          <p className="lp-row-proof">{contract.short}</p>
                        </a>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              <Subhead>Reading it yourself</Subhead>
              <Rows
                rows={[
                  {
                    title: "The source",
                    body: (
                      <>
                        Every contract, with the reasoning written into it as comments —{" "}
                        <a href={CONTRACTS_SRC} rel="noopener noreferrer" target="_blank">
                          contracts/
                        </a>
                        . <code>HandleEscrow.sol</code> opens with a plain description of its own trust model,
                        including the weakness in §04. We put it there before we put it here.
                      </>
                    ),
                  },
                  {
                    title: "The tests",
                    body: (
                      <>
                        <a href={`${GITHUB}/blob/main/contracts/HandleEscrowSecurity.t.sol`} rel="noopener noreferrer" target="_blank">
                          HandleEscrowSecurity.t.sol
                        </a>{" "}
                        and{" "}
                        <a href={`${GITHUB}/blob/main/contracts/HandleEscrowBounds.t.sol`} rel="noopener noreferrer" target="_blank">
                          HandleEscrowBounds.t.sol
                        </a>{" "}
                        exist to prove the promises in §02 — including that a reclaim can never be blocked and
                        that a reused note always fails.
                      </>
                    ),
                  },
                  {
                    title: "The two limits, live",
                    body: escrow ? (
                      <>
                        The hold window and daily ceiling printed in §02 were read off{" "}
                        <a href={escrow.url} rel="noopener noreferrer" target="_blank">
                          the escrow itself
                        </a>{" "}
                        when you loaded this page. Ask it the same questions and you will get the same answers.
                      </>
                    ) : (
                      <>
                        Both limits are fixed when the contract is published and can be read back from it by
                        anyone, which is where the figures in §02 come from.
                      </>
                    ),
                  },
                  {
                    title: "Your own receipt",
                    body: (
                      <>
                        Each bill carries a fingerprint of the receipt photo it came from. Before paying, the app
                        recomputes it and shows you whether it matches what was recorded — so a split cannot be
                        quietly edited after the fact. See{" "}
                        <Link href="/docs#bill-verification">bill verification</Link>.
                      </>
                    ),
                  },
                ]}
              />

              <Subhead>If you find something wrong</Subhead>
              <p>
                Tell us before you tell anyone else and we will fix it. Reports go to{" "}
                <a href="mailto:security@splitsy.xyz">security@splitsy.xyz</a> — also published at{" "}
                <a href="/security.txt" rel="noopener noreferrer" target="_blank">
                  /security.txt
                </a>
                . If you believe a payment of yours has gone somewhere it shouldn&apos;t, reclaiming your waiting
                deposits is the first thing to do and it needs nothing from us.
              </p>

              <div className="mt-8 flex flex-wrap items-center gap-3" data-reveal="item">
                <a className="primary-button" href={CONTRACTS_SRC} rel="noopener noreferrer" target="_blank">
                  Read the contracts
                </a>
                <Link className="group secondary-button flex items-center gap-1.5" href="/docs#security">
                  The technical version
                  <ArrowUpRight
                    className="transition-transform duration-[var(--dur-2)] group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
                    size={14}
                  />
                </Link>
              </div>
            </Section>
          </article>
        </div>
      </main>
    </div>
  );
}
