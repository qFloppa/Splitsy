import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";

import { Nav } from "@/components/landing/Nav";

// The shell both legal documents are set in.
//
// It exists because there are exactly two of them and they are the same object: a
// head, an index, a numbered run of clauses, and a colophon. Nothing here is a new
// design — every class it reaches for belongs to the app or the landing already
// (see globals.css, "The two documents"). What it owns is the one thing the old
// pages got wrong twice over: the index and the clauses are two renderings of ONE
// array, so a clause cannot be listed under a number it does not print, and a
// clause inserted in the middle renumbers both at once.
//
// A server component. The old pages wrapped themselves in DocsShell — a client
// component whose only job was a second theme toggle writing a second storage key
// — and the site header has carried the real one since the redesign. So there is
// nothing to hydrate on either route but the header itself.
//
// No scroll-reveal, deliberately, and this is the one place the landing's grammar
// is knowingly not followed. useReveal starts a node at autoAlpha: 0 and brings it
// in on scroll; a page whose entire purpose is that its terms were legible would
// be shipping its terms invisible-until-scrolled, and taking Ctrl+F, reader mode
// and print with it. The section rules still draw themselves, because .lp-paper
// does that in pure CSS off a view() timeline with no JS at all.

export type LegalClause = {
  /** Anchor id. Stable across edits — these get linked to from outside. */
  id: string;
  title: string;
  /** Running head. Consecutive clauses sharing one become a group in the index. */
  part?: string;
  body: ReactNode;
};

type LegalDocProps = {
  eyebrow: string;
  /** Carries a <span className="lp-headline-accent"> on the clause that matters. */
  title: ReactNode;
  lede: ReactNode;
  glance: { label: string; value: string }[];
  clauses: LegalClause[];
  /** ISO date. Printed on the index rail, where a reader goes to check it. */
  updated: string;
  /** The other document. Every legal page should hand you the one it depends on. */
  sibling: { href: string; label: string };
  /** The closing addresses — who to write to, and about what. */
  colophon: ReactNode;
};

type Numbered = LegalClause & { n: string };

/** Consecutive clauses sharing a part, in document order. The ordinal is assigned
 *  from the flat array first, so grouping can never renumber anything. */
function group(clauses: LegalClause[]): { part?: string; clauses: Numbered[] }[] {
  return clauses.reduce<{ part?: string; clauses: Numbered[] }[]>((groups, clause, index) => {
    const numbered = { ...clause, n: String(index + 1).padStart(2, "0") };
    const open = groups.at(-1);
    if (open && open.part === clause.part) open.clauses.push(numbered);
    else groups.push({ part: clause.part, clauses: [numbered] });
    return groups;
  }, []);
}

export function LegalDoc({
  eyebrow,
  title,
  lede,
  glance,
  clauses,
  updated,
  sibling,
  colophon,
}: LegalDocProps) {
  const groups = group(clauses);
  const numbered = groups.flatMap((entry) => entry.clauses);

  return (
    <div className="lp-paper legal-paper">
      <Nav />
      <main id="main">
        {/* ── the head ─────────────────────────────────────────────────────── */}
        <section aria-labelledby="doc-title" className="lp-measure legal-head">
          <p className="settle-label">{eyebrow}</p>
          <h1 className="lp-display-lg mt-4 max-w-4xl" id="doc-title">
            {title}
          </h1>
          <p className="lp-lede mt-6 max-w-2xl">{lede}</p>

          {/* The bordered "at a glance" panel, as the app's own labelled rail. */}
          <dl className="bill-contents legal-glance">
            {glance.map((fact) => (
              <div className="bill-cell" key={fact.label}>
                <dt className="settle-label">{fact.label}</dt>
                <dd className="bill-contents-label">{fact.value}</dd>
                <div className="bill-cell-rule" />
              </div>
            ))}
          </dl>
        </section>

        {/* ── the index ────────────────────────────────────────────────────── */}
        <section
          aria-labelledby="doc-contents"
          className="bill-poster legal-contents"
          data-parts={groups.length}
        >
          <div className="lp-measure">
            <div className="bill-poster-head">
              <h2 className="settle-label" id="doc-contents">
                Contents
              </h2>
              <span className="bill-poster-fact">
                <b>{numbered.length}</b> clauses · last updated <b>{updated}</b>
              </span>
            </div>

            <div className="doc-index bill-poster-body">
              {groups.map((entry) => (
                <div key={entry.part ?? "all"}>
                  {entry.part && (
                    <h3 className="bill-subhead">
                      <span className="settle-label">{entry.part}</span>
                    </h3>
                  )}
                  {/* role="list" survives list-style: none, which Safari otherwise
                      takes as permission to drop the list semantics entirely. */}
                  <ol className="lp-rows m-0 list-none p-0" role="list">
                    {entry.clauses.map((clause) => (
                      <li key={clause.id}>
                        <a className="lp-row" href={`#${clause.id}`}>
                          <span className="doc-index-n">{clause.n}</span>
                          <span className="bill-contents-label">{clause.title}</span>
                        </a>
                      </li>
                    ))}
                  </ol>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── the clauses ──────────────────────────────────────────────────── */}
        {numbered.map((clause) => (
          <section
            aria-labelledby={`${clause.id}-title`}
            className="bill-poster scroll-mt-28"
            id={clause.id}
            key={clause.id}
          >
            <div className="lp-measure">
              {clause.part && (
                <div className="bill-poster-head">
                  <span className="settle-label">{clause.part}</span>
                </div>
              )}
              {/* The ordinal the index sent you here by. .bill-section-title is the
                  app's "a section that names itself" — the treatment written for
                  exactly this case: many sections, one scroll, and a reader who has
                  to know which one they landed in. */}
              <h2 className="bill-section-title" id={`${clause.id}-title`}>
                <span className="bill-section-index">{clause.n}</span> {clause.title}
              </h2>
              <div className="doc-prose">{clause.body}</div>
            </div>
          </section>
        ))}

        {/* ── the colophon ─────────────────────────────────────────────────── */}
        <section aria-labelledby="doc-next" className="bill-poster" data-last>
          <div className="lp-measure">
            <div className="bill-poster-head">
              <h2 className="settle-label" id="doc-next">
                Read next
              </h2>
              <span className="bill-poster-fact">Arc Testnet · test USDC only</span>
            </div>
            <div className="doc-prose">{colophon}</div>
            <div className="bill-poster-foot">
              {/* .settle-action is the borderless display word the /pay poster and
                  the landing's hero both close with. Neither document is complete
                  without the other, so the way out of one is the other. */}
              <Link className="settle-action lp-call" href={sibling.href}>
                {sibling.label}
                <ArrowRight aria-hidden size="0.6em" />
              </Link>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
