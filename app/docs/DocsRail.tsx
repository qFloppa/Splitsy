"use client";

import { useEffect, useRef } from "react";

import DocsSearchInput from "./DocsSearchInput";
import { SECTIONS } from "./sections";

// The index, travelling.
//
// /legal gets away with a contents poster you scroll past once, because nineteen
// short clauses fit in about the distance a reader will hold in their head. This
// document is sixteen sections and 1,600 lines, five of which are 60% of it —
// autopay-agents alone is longer than the whole disclaimer. An index you passed
// 900 lines ago is not an index, so this one comes with you.
//
// Its rows are the poster's rows: the same .doc-index arrangement, the same mono
// ordinal, the same rule that lights. A reader who used the poster to get here
// should not have to learn a second list to keep navigating.
//
// ── Why the spy goes quiet during a search ───────────────────────────────────
// The rail has two jobs and can only do one at a time. Empty, it is an index and
// marks the section you are reading. With a query, DocsSearchInput hides the rows
// that do not match and re-ranks the rest by score (see reorderSidebar there) —
// at which point "the section you are reading" is not what the rows are ordered
// by, and marking one of them makes the rail describe itself two ways at once.
//
// The observer below keeps running and keeps writing data-state anyway; what goes
// quiet is the mark, in CSS, off the data-searching the search writes on this
// element. Two reasons it belongs there and not in this file. The mark already on
// a row when the query is typed has to go too, and typing scrolls nothing, so no
// callback fires to clear it — a guard here would leave exactly the stale mark it
// was added to prevent. And the observer's book on where you are stays current
// while you read the results, so clearing the field puts the mark back on the
// section you are actually in rather than wherever the last scroll callback left
// it.
export function DocsRail() {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const rail = ref.current;
    if (!rail) return;

    const nodes = SECTIONS.map((entry) => document.getElementById(entry.id)).filter(
      (node): node is HTMLElement => node !== null,
    );
    if (nodes.length === 0) return;

    // Where a heading actually comes to rest, read off the section's own
    // scroll-margin rather than off the rail's `top`. Both are --doc-rail-top, but
    // scroll-margin computes to px on every breakpoint, while the rail's `top` is
    // `auto` below 1000px where it stops being sticky.
    const restTop = Number.parseFloat(getComputedStyle(nodes[0]).scrollMarginTop) || 0;

    // ponytail: an IntersectionObserver, not a scroll listener — the browser does
    // the work off the main thread and there is nothing to throttle. Same reason
    // components/landing/Nav.tsx uses one for the masthead's stuck state.
    //
    // The band runs from where a heading rests down to 45% of the viewport. A
    // percentage, not `window.innerHeight` arithmetic, so it survives a resize and
    // the address-bar height changes a phone makes mid-scroll without rebuilding
    // the observer.
    //
    // More than one section can be in that band at once — this page pairs a
    // 20-line section with a 324-line one — so intersection alone cannot pick.
    // Document order breaks the tie: among the sections in the band, the earliest
    // is the one you have scrolled furthest into, and that is the one you are
    // reading.
    //
    // Except at the foot of the document, where that reasoning inverts. The last
    // section cannot be brought to the top of the band — the scroll runs out
    // first — so it shares the band with the section above it forever, and
    // "earliest wins" would mean the final row could never light at all. Clicking
    // the last row in the rail and watching the second-to-last one mark is the
    // most obvious way for a reader to conclude the rail is broken. Once scrolling
    // is exhausted, the one you are reading is the last one in view.
    const visible = new Set<string>();
    const rows = new Map(
      SECTIONS.map((entry) => [
        entry.id,
        rail.querySelector<HTMLElement>(`a[href="#${entry.id}"]`),
      ]),
    );

    const paint = () => {
      const inBand = SECTIONS.filter((entry) => visible.has(entry.id));
      // 2px of slack: a fractional device pixel ratio leaves the bottom a hair
      // short of the arithmetic.
      const atBottom =
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      const current = (atBottom ? inBand.at(-1) : inBand[0])?.id;
      for (const [id, row] of rows) {
        if (!row) continue;
        if (id === current) row.dataset.state = "active";
        else delete row.dataset.state;
      }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        paint();
      },
      { rootMargin: `-${restTop}px 0px -45% 0px` },
    );

    for (const node of nodes) observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <aside aria-labelledby="doc-rail-title" className="doc-rail" data-searching="false" ref={ref}>
      <p className="settle-label" id="doc-rail-title">
        Contents
      </p>

      <DocsSearchInput />

      {/* An <ol> of <li>, not the bare stack of <a> the old sidebar was: sixteen
          ordered destinations are a list, and the ordinal printed beside each one
          only means anything if the order is real. role="list" survives
          list-style: none, which Safari otherwise takes as permission to drop the
          list semantics entirely.

          The consequence, and the reason this is worth a note: the search ranks
          these rows by writing `order`, which only moves an element among its own
          parent's grid children. With <li> in between, that parent is this <ol> —
          so reorderSidebar walks up to the <li> rather than styling the <a>, and
          .doc-index has to stay a grid for it to land. */}
      <ol className="doc-index doc-rail-index m-0 list-none p-0" role="list">
        {SECTIONS.map((entry) => (
          <li key={entry.id}>
            <a className="doc-index-row lp-row" href={`#${entry.id}`}>
              <span className="doc-index-n">{entry.n}</span>
              <span className="bill-contents-label">{entry.title}</span>
            </a>
          </li>
        ))}
      </ol>
    </aside>
  );
}
