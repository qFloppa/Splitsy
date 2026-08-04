# Settle deck — the /pay design for every debt and claim

**Date:** 2026-08-05
**Status:** approved, not yet implemented

## Problem

`/pay/[token]` — the public share link — got a full-bleed poster treatment: a
sticky ink panel carrying the merchant name and the headline amount at display
scale, beside a scrolling roster of payer rows. It reads as a considered object.

Inside the app, the same money moves through two stacked cards in the Bills tab:
a merged "You owe" panel and a "Funds you can collect" panel. Both are dense,
bordered, collapse-by-default, and identical in weight to the six other panels
around them. Paying a bill and reading a settings note look the same.

This spec brings the `/pay` treatment inside, as the only place in the app where
debts are paid and claims are collected.

## Scope

A new top-level `Settle` tab presenting every pending debt and every pending
claim as a full-viewport scroll-snap deck. The existing inbox panels are deleted,
not duplicated.

Out of scope: recurring tabs (their own surface), history, the public
`/pay/[token]` page itself (unchanged), and every route, contract call, and
signing path (unchanged).

## Decisions

Four forks were settled before design:

1. **New top-level tab, old panels removed.** One place to pay. The alternative —
   keeping the Bills panels — means two payment UIs that can disagree about the
   same debt.
2. **Full-viewport scroll-snap deck.** One flick, one bill. Rejected: a pinned
   hero with a list below (only ever one bill is big), and accordion rows
   (nothing is big until clicked, so the surface has no impact on arrival).
3. **One deck, debts then claims, divider between.** One uninterrupted gesture
   and one counter. Rejected: merging by urgency, which flips the action verb
   between Pay and Collect unpredictably as you scroll — a misclick risk on money.
4. **Progress renders in the section.** `ProgressModal` and the `XDebtsPanel`
   dialog would slam a bordered card over the design at the moment it matters
   most.

## Architecture

### The tab

`AppTab` (`app/HomeClient.tsx:174`) gains `"settle"`. A `TabButton` sits between
Bills and Recurring carrying a live count badge.

The Settle branch renders **outside** the `max-w-7xl` wrapper at
`app/HomeClient.tsx:2663`. That wrapper is padded and centred; a full-bleed
poster cannot live inside it. The other four tabs keep it.

### Deletions

| What | Where |
|---|---|
| merged "You owe" `Panel` block | `app/HomeClient.tsx:2738–2796` |
| `WalletDebtRows` | `app/HomeClient.tsx:3445–3693` |
| `ClaimFundsPanel` | `app/HomeClient.tsx:3695–3842` |
| `XDebtsPanel` (whole file) | `app/XDebtsPanel.tsx` |
| `socialPendingCount`, `socialPendingTotalUsd`, `debtsExpanded` state | `app/HomeClient.tsx:405–413`, `:519–524` |

Net effect on `app/HomeClient.tsx`: roughly 400 lines removed, before the
`BillVerification` move below removes ~280 more.

### New files

| File | Purpose |
|---|---|
| `app/SettleDeck.tsx` | the deck, its sections, and the two sheets |
| `app/BillVerification.tsx` | `BillVerification` moved out of HomeClient (`:5408–5688`), split into `useBillVerification()`, the existing inline panel, and a `VerifiedSheet` presentation |
| `lib/settle-items.ts` | pure merge of social debts, wallet debts, and claims into one ordered `SettleItem[]` |
| `lib/settle-items.test.ts` | `node:test`, following `lib/pay-link.test.ts` |
| `lib/use-social-debts.ts` | the `/api/bills` → `iOwe` fetch lifted out of `XDebtsPanel`, following `lib/use-theme.ts` |

`BillVerification` is **moved, not copied**. It has a second consumer at
`app/HomeClient.tsx:3995` (`BillActivityDetail`, in History) which keeps using
the inline panel form.

### Modified files

| File | Change |
|---|---|
| `app/HomeClient.tsx` | `AppTab` gains `"settle"`; tab button; render `SettleDeck` outside the padded wrapper; the deletions above; header becomes `sticky` on this tab; `subjectKey` added to `ProgressFlow` |
| `app/globals.css` | new `.settle-*` block beside the existing `.pay-*` block |
| `package.json` | `test:settle` script |

### Money paths

Unchanged. The deck receives the existing handlers as props, exactly as
`WalletDebtRows` does today: `payDebtOnArc`, `claimSplitterFunds`, `refundOnArc`,
`bridgeForDebt`, `partialPayments`, `claimAmounts`, `billState`, `debtMessages`,
`arcUsdcBalances`.

One addition: a `subjectKey` field on `ProgressFlow` (`app/HomeClient.tsx:197`)
so the deck knows which section owns the running flow. `progressFlow` stays a
single global object, which is correct — `billState === "working"` is already
global, so only one payment runs at a time.

## Data model

`lib/settle-items.ts` exports one type and one pure function:

```ts
type SettleItem =
  | { kind: "debt-social"; id: string; amountUsd: number; editable: false; … }
  | { kind: "debt-wallet"; id: string; debt: OwnedBillSplitDebt; editable: boolean; … }
  | { kind: "divider";     claimCount: number; totalUsd: number }
  | { kind: "claim";       id: string; debt: OwnedBillSplitDebt; editable: boolean; … }
  | { kind: "end";         settledThisSession: number }

buildSettleItems({ socialDebts, walletDebts, splitterBills, nowSeconds }): SettleItem[]
```

**`editable` is derived here, once**, as `debt.via === "wallet"`. That mirrors
what the server enforces: `app/api/onchain-bills/[billId]/pay/route.ts:35` reads
the debt from chain and never trusts a client amount, and the social route
transfers `debt.amount_usdc` whole. Deriving it in the component would let the
two drift.

**Ordering.** Wallet and social debts interleaved by due date, undated last, then
amount descending. Refund-only rows — `remaining === 0n` but refundable, the case
`app/HomeClient.tsx:516` deliberately keeps — sort to the end of the debt run.
The divider is omitted when either side is empty. The end card is always last.

**Section identity is `${billId}:${account}`**, never bare `billId`. A
dual-identity user can hold the same bill on two wallets; the existing code
already keys this way (`app/HomeClient.tsx:3508`), and collapsing on `billId`
would merge two real debts into one section.

## Visual system

The deck is one poster field reusing the existing `--pay-poster-*` tokens
(`app/globals.css:42–48`, `:131–136`), so light and dark already work and no new
tokens enter the system. CSS lives beside the `.pay-*` block in
`app/globals.css` under a `.settle-` prefix.

**Type.** Clash Display **300** across the surface — merchant, amount, button,
labels. `--font-clash` is already a 200–700 variable face (`app/layout.tsx:18`),
so Light costs nothing. Geist Mono survives in one role only: hashes and
addresses, where character disambiguation matters.

### Section anatomy

```
01 / 05                                    arc testnet     11px, 0.18em tracking, dim

   to @ana · x                                             13px, dim
   Cider Cellar                                            Clash 300, clamp(3.2rem, 1.4rem + 7vw, 9rem)
                                                           line-height 0.9, tracking -0.03em
   you pay                                                 11px uppercase tracked
   $42.50                                                  input, Clash 300, clamp(3rem, 1.4rem + 6vw, 7rem)
   ────────────────────────────                            hairline, brightens and widens on focus
   of $42.50 remaining · due 12 aug                        12px dim

              P a y   →                                    Clash 300, clamp(2.2rem, 1rem + 3.2vw, 4.4rem)
                                                           no border, no background, 0.14em tracking

   ⌄ verified on arc              ⌄ bridge                 hairline triggers, bottom edge
```

A non-editable amount (`editable: false`) renders as the same giant numeral with
no rule beneath it and a small `settles in full from your splitsy wallet` note.
Identical visual mass; the affordance is the only difference, so the deck never
changes shape between sections.

### The faded button — one deliberate deviation

The brief asked for a pay button "faded to the background". At the opacity that
implies (~22%) it fails WCAG contrast, and it is the control that moves money.

Resolution: rest state is the lowest mix that still clears 4.5:1 against the
poster background — approximately 58% in dark, 62% in light — reaching 100% with
a tracking tighten on hover and focus. It still reads as faded; it cannot be
invisible. It carries a real focus ring (`outline: 1px solid currentColor;
outline-offset: 0.6em`) because with no border there is otherwise nothing to
indicate focus. `prefers-contrast: more` makes it fully opaque.

Every other control on this surface — Collect, get my money back, the bridge
chain buttons — follows the same borderless rule.

### Sheets

**One** sheet element at deck level, keyed by `{ sectionId, kind }`. Only one can
be open at a time, and a viewport-fixed element sidesteps the stacking-context
traps that `position: absolute` inside a scroll-snap container invites.

`translateY(100%) → 0`, ~70dvh, `backdrop-filter: blur(20px)`, rounded top
corners. Closes on Escape, outside click, or scroll. Focus moves in on open and
returns to the trigger on close.

- **verified on arc** — merchant name as the heading, the two existing checks
  from `useBillVerification`, the due-date line, and the receipt image.
- **bridge** — the CCTP explainer and the six `bridgeSourceChains` buttons,
  restyled borderless.

### Amount field

`<input inputmode="decimal">` styled to nothing — no border, no background,
inheriting the giant Clash. `font-variant-numeric: tabular-nums`. If Clash's
tabular figures prove absent, digits will jitter while typing; the fallback is a
fixed `ch` width per digit, not a face swap.

### Divider card

Full height, centred: `owed to you` over `2 bills · $60.00`, with a hairline
that draws outward from centre as it enters.

## Motion

**Scrolling is native.** `.settle-deck` is its own scroll container with
`scroll-snap-type: y mandatory`; each section is `height: 100%;
scroll-snap-align: start`. Deliberately **no** `overscroll-behavior: contain` —
default scroll-chaining is what lets the last card hand off to the document so
the site footer stays reachable.

**Header sizing needs two small changes.** The app header
(`app/HomeClient.tsx:2613`) is `position: static`, so it scrolls away with the
document, and there is no existing `--app-header-h` token. Sizing the deck to the
viewport therefore requires:

1. the header becomes `sticky top-0` **while the Settle tab is active** (other
   tabs keep `static`, so nothing else changes);
2. a `ResizeObserver` on the header publishes its measured height as
   `--app-header-h` on the root, and the deck is
   `height: calc(100dvh - var(--app-header-h))`.

The height cannot be hardcoded the way `.pay-shell` hardcodes `4rem`
(`app/globals.css:3072`) — the app header stacks to a taller two-row layout below
the `md` breakpoint.

**Lenis is not used**, despite being a dependency. Smooth-scroll libraries own
the scroll position and fight CSS snap; together they drift.

**One IntersectionObserver** (threshold 0.6) sets `data-active` on the entering
section and updates the rail counter. Everything else is CSS transitions off that
attribute — no rAF loop, no scroll listener.

| Element | On activation |
|---|---|
| merchant | `clip-path: inset(0 0 100% 0)` → `inset(0)` with `translateY(0.3em)` → `0`, 520ms `--ease-out` |
| you pay / amount / rule | same reveal, staggered +80ms, +140ms |
| hairline rule | `scaleX(0)` → `1`, origin left, 600ms |
| Pay button | fades in last, +260ms |
| neighbouring sections | `opacity: 0.25; scale: 0.98` |
| divider card | rule draws outward from centre, 700ms |

`split-type` is a dependency but is **not used** — a CSS `clip-path` reveal
survives OCR merchant names that wrap to three lines; per-character spans do not.
Rejected for the same class of reason: counting the amount up from `$0.00`, since
that number lives in an `<input>` and animating a field's value fights focus and
the caret.

**Paying, in place.** The field cross-fades (140ms) into a step ticker driven by
`progressFlow.steps` — the existing `FlowStep[]`, rendered as lines rather than
as `ProgressModal`'s card. The rule becomes an indeterminate shimmer for wallet
steps and a determinate fill for bridge steps, which already report progress. On
success the section resolves to `settled` with a tx link, holds ~1.2s, then
`scrollIntoView({ behavior: "smooth" })` on the next unsettled section. On
failure the rule turns warning-toned and the message renders in place from the
existing `debtMessages[billId]`.

**Confetti moves.** It currently fires per social payment
(`app/XDebtsPanel.tsx:27`). Under every card in a deck that is noise. It fires
once, on the end card, when the last item clears.

**End states.** Empty on arrival: a single full-height `nothing waiting on you`
card. Emptied during the session: the same card with the confetti beat and a
total-settled figure.

**`prefers-reduced-motion: reduce`** collapses every transform and clip-path to
opacity-only, drops the shimmer, makes the advance a jump, and skips the
confetti — matching the seven existing blocks in `app/globals.css`. Snap itself
stays; it is not motion.

## Edge cases

| Case | Behaviour |
|---|---|
| Item settles and the list reorders mid-scroll | The settled section stays mounted in its resolved state until the advance completes, then unmounts. Without this the deck jumps under the user's thumb the instant a payment lands. |
| Escrow-held debt | The existing escrow explanation replaces the meta line; Pay stays available. |
| Failed all-or-nothing bill, creditor side | Its own section: `this bill didn't come together`, no action. Mirrors `failedBills` at `app/HomeClient.tsx:3719`. |
| Bill unverified or hash mismatch | The trigger reads `⌄ doesn't match arc` in warning tone and the sheet auto-opens on activation. A red banner does not belong behind a click. |
| Verification still loading | The trigger shows a quiet `checking…`. Pay is **not** blocked — it is not blocked today, and blocking it would be a new restriction smuggled in as a redesign. |
| Signed out, no wallet | The end card with a sign-in line, rather than an empty scroll container. |
| Exactly one item | No rail counter, no snap chrome. |
| Amount typed above remaining | Rule turns warning-toned, Pay disabled, `more than the $42.50 remaining`. Client-side only; the contract clamps regardless. |

## Testing

`lib/settle-items.test.ts` via `node --test`, added as a `test:settle` script
alongside `test:pay-link`:

- ordering across mixed due dates, undated, and equal dates
- divider omitted when either side is empty
- refund-only rows placed last and never dropped
- `editable === false` for every `via: "social"` item
- same `billId` on two accounts producing two distinct sections

The visual layer is not unit-tested.

**Verification before the work is called done:** `npm run lint`,
`npx tsc --noEmit`, the new test, then the app exercised with (a) social debt
only, (b) wallet debt only, (c) both plus claims, (d) empty — and a
keyboard-only pass through one complete payment.

## Risks

- **`app/HomeClient.tsx` is 5,825 lines.** The deletions and the
  `BillVerification` move touch it heavily. Both are mechanical, but the file's
  size makes a careless edit easy; the move should land as its own commit before
  the deck is wired in.
- **Snap plus dynamic list length.** Sections unmounting while snapped is the
  most likely source of jumpiness. The hold-then-unmount rule above is the
  mitigation and is the thing to test first.
- **Clash Display tabular figures** are unconfirmed. Checked during
  implementation on the amount field, which is where jitter would show.
