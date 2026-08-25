# /docs in the redesign's own grammar

**Date:** 2026-08-26
**Status:** approved, ready to implement

## Why

`/docs` is the last route wearing the pre-redesign skin, and it wears more of it
than `/legal` and `/disclaimer` did. Those two carried the four things the
redesign took out everywhere else — an icon in a circle beside every heading, a
bordered "at a glance" panel, tinted callout boxes, and a theme toggle writing a
storage key nothing else reads. `/docs` carries all four **plus a complete
parallel colour system**: `--docs-bg`, `--docs-text`, `--docs-muted`,
`--docs-border`, `--docs-card`, `--docs-link`, `--docs-accent-soft`,
`--docs-callout-bg`, and a light/dark pair for each. 193 lines of CSS deciding,
on one route, what dark mode means.

The redesign's ground truth is `--pay-poster-fg` / `--pay-poster-bg` /
`--pay-poster-rule`, mixed against each other, and one rule above all: nothing
draws a box.

## What this is not

Not a rewrite of the documentation. Every sentence, table cell, figure and
external reference carries over verbatim. What changes is the chrome around
them and the order of one section.

## Inventory (what has to be re-housed)

| | count |
|---|---|
| sections | 16 |
| `InfoCard` (bordered, icon in a tinted square) | 37 |
| `Step` (numbered circle) | 40 |
| `Callout` (tinted, bordered box) | 16 |
| tables | 15 |
| `docs-subheading` (h3) | 25 |
| lists | 3 |
| code block | 1 |
| sources list | 1 |

Section weights are lopsided — `autopay-agents` is 324 lines, `operations` is
20. Five sections are ~60% of the page. This is why the sticky rail exists: on
a single scroll of this length, an index you passed 900 lines ago is not an
index.

## Decisions

### One document, not routed sub-pages

`/docs` stays a single scroll. Splitting it would break every `#anchor` in the
wild, turn `DocsSearchInput` into a build-time cross-page index, and cost
whole-document Ctrl+F, reader mode and print. The scroll length is answered by
a sticky rail instead.

### No icons

53 glyphs (37 card + 16 heading) are dropped. "An icon in a circle beside every
heading" is named in globals.css as one of the things the redesign removed; the
replacement mark is the ordinal, which `LegalDoc` already proves out. A serious
document numbers its sections. It does not illustrate them.

Removes ~34 `lucide-react` imports from the page.

### Ordinals from one array

The contents index, the sticky rail and the section heads are three renderings
of one array, so a section cannot be listed under a number it does not print,
and "§09" keeps meaning §09 as the document grows. Same construction as
`components/LegalDoc.tsx`.

**Every `id` is unchanged.** External anchors and the page's own cross-links
(`href="#autopay-agents"` and friends) keep resolving.

### Parts

| | Part | Sections |
|---|---|---|
| I | Using Splitsy | 01 `overview` · 02 `using-splitsy` · 03 `sign-in-and-wallets` · 04 `bill-splits` · 05 `recurring-tabs` |
| II | What the chain guarantees | 06 `bill-verification` · 07 `payment-reputation` · 08 `circle-and-arc` |
| III | The agent economy | 09 `autopay-agents` · 10 `scout-agent` · 11 `net-settlement-treasury` |
| IV | Under the hood | 12 `architecture` · 13 `contracts` · 14 `operations` · 15 `security` · 16 `configuration` |

`.legal-contents[data-parts]` already switches from a capped single column to
`auto-fit` columns at 900px. Four parts need no new grid rule.

**One reorder:** `recurring-tabs` moves 7th → 5th, beside `bill-splits`, the
one-time-bill flow it is the counterpart to. It currently sits orphaned between
`payment-reputation` and `circle-and-arc`. Nothing else moves.

### The rail, and its conflict with search

Two columns: a sticky rail and the article. Rail rows are the index rows —
`a.lp-row` at index scale, mono tabular ordinal, title at full ink.

Scroll-spy marks the current row `data-state="active"`, reusing
`.bill-contents-entry[data-state="active"]`'s existing gesture (label to ink,
rule to a lit 2px) — the same primitive the bills tab uses for step progress.
`IntersectionObserver`, not a scroll listener.

**The conflict:** search already writes to this rail. It hides non-matches and
re-ranks the survivors via CSS `order`. Scroll-spy pointing at "where you
happen to be" while the rail shows "best three matches, ranked" is two
mechanisms describing the same rows differently. So the rail has one mode
switch:

- **empty query** → an index; scroll-spy live
- **active query** → a ranked result list; scroll-spy stood down via
  `data-searching` on the rail

**Mobile:** the rail does not become a second 16-link list stacked above the
article. It collapses to the search field alone — the contents poster is
already the index.

### Search is preserved

`DocsSearchInput` is a real feature with a fuzzy scorer, a `TreeWalker`
highlighter, `/` and ⌘K shortcuts, keyboard result nav, deep-scroll to the first
matching block, and a test. It stays.

Its DOM contract is preserved deliberately: `.docs-section` stays on each
section and `.docs-sidebar` on the rail, purely as hooks. Only two subhead
selectors repoint:

- `.docs-card h3` → `.doc-row-title`
- `.docs-callout strong` → `.doc-note .settle-label`

`search-score.ts` is untouched, so `search-score.test.ts` keeps passing
unchanged. The input is restyled to a bare ruled field — no box.

### Body vocabulary

| Was | Becomes |
|---|---|
| `SectionHeading` (icon + h2) | `.bill-section-title` + `.bill-section-index`; part as `.settle-label` in `.bill-poster-head` |
| `InfoCard` × 37 | ruled rows in `.lp-rows`; title `.doc-row-title` at ink, body in prose; 2-col ≥900px |
| `Step` × 40 | `.lp-step-num` — mono, `opacity: .55`, a position in a sequence the eye can skip |
| `Callout` × 16 | `.doc-note` — full-ink top rule + caps label |
| tables × 15 | `.bill-table` / `.bill-table-wrap`, plus a left-align override (it right-aligns non-first columns for figures; these are prose) |
| `docs-subheading` × 25 | `.bill-subhead`'s arrangement — label, rule running to the end — but **not** its caps. 0.18em tracking across a 60-character sentence is unreadable. Title-case Clash at ink. |
| `docs-code` / `pre` | mono, ruled top and bottom, `overflow-x: auto`, no panel |
| lists × 3 | `.doc-prose ul`'s ruled rows |
| `docs-sources` | `.lp-rows` of external links |

### No scroll-reveal

`LegalDoc` skips it so terms stay Ctrl-F-able and printable. `/docs` has a
stronger reason: its search reads `section.textContent` and wraps hits in
`<mark>`. A document shipping its body at `autoAlpha: 0` would be a document
whose search highlights things you cannot see.

`.lp-paper`'s section rules still draw themselves — pure CSS off a `view()`
timeline, no JS.

### The rename

`.legal-index`, `.legal-index-n`, `.legal-prose`, `.legal-note` are about to be
shared by a page that is not legal. They become `.doc-index`, `.doc-index-n`,
`.doc-prose`, `.doc-note`. Six call sites across `components/LegalDoc.tsx`,
`app/legal/page.tsx`, `app/disclaimer/page.tsx`. The alternative — duplicating
the rules under a second name — is the thing this system's CSS comments warn
against repeatedly.

`.legal-paper`, `.legal-head`, `.legal-glance`, `.legal-contents` stay: those
are the two legal documents' own, and `/docs` gets `.doc-paper` /
`.doc-head` equivalents where its needs differ.

## Files

| File | Change |
|---|---|
| `app/docs/page.tsx` | rebuilt; content verbatim, chrome replaced |
| `app/docs/DocsShell.tsx` | **deleted** — a second theme toggle on a second storage key |
| `app/docs/DocsRail.tsx` | **new**; client — sticky rail, scroll-spy, wraps the search field |
| `app/docs/DocsSearchInput.tsx` | two selectors, input restyle |
| `app/globals.css` | −193 `docs-*` lines; + a documented `/docs` block; four renames |
| `components/LegalDoc.tsx` | class renames |
| `app/legal/page.tsx`, `app/disclaimer/page.tsx` | `.legal-note` → `.doc-note` |

## Verification

1. `npx tsc --noEmit`
2. `npm run lint`
3. `npm run build`
4. `rm -rf .next` — Turbopack serves stale CSS otherwise
5. CDP screenshots, both themes, at desktop and mobile widths
6. By hand: every one of the 16 anchors resolves; search filters, ranks,
   highlights, and `/` + ⌘K still focus; scroll-spy tracks and stands down
   during a query
