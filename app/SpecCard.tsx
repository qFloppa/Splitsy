// The shells every app tab is built from. Deliberately not a "use client"
// entry point: all of them are imported only by client components, and marking
// them one would force every prop to be serializable — which the ReactNode
// slots are not.
//
// One system is left. Every tab is a .bill-poster: a section is type on a
// hairline and the figure IS the field. Bills (both subtabs, every step),
// Recurring, Agents (all four sections), and the Dashboard — its four readings,
// its three treasury steps, and the paper trail at its foot.
//
// The spec-sheet system that used to live here — .spec-card's bordered card with
// a header bar, opened by a .tab-hero — is gone. The dashboard was its last
// screen, which meant the one tab whose entire job is to be read was also the
// only one that read as a different product. Its CSS survives in globals.css
// because the landing page still borrows .spec-card-live for one panel; nothing
// in the app does. Mixing two systems inside one tab is what makes an app look
// assembled rather than designed, so there is now only one to pick.
//
// PosterValue/PosterCell/PosterFact live here rather than in HomeClient because
// several tabs set their figures as posters, and a component two of them have to
// import cannot sit inside the third.
import { useState, type ReactNode } from "react";
import { typableAmount } from "@/lib/iou";

// One row of a tab's contents index: the step's number, what it does, and how far
// the user has got.
type LegendRow = { step: string; label: string; state?: "done" | "active" };

// One section of a tab, named once. The ordinal and the kicker are what the
// contents rail prints; the title is what the section itself says in display type.
// Both readings come off this one row, so the index in the masthead and the
// heading you scroll to can never name a section differently.
export type Step = { index: string; kicker: string; title: string };

// The contents rail for a tab, built from its steps. `states` is positional and
// may be short or sparse — a tab whose progress is a single "you are here" passes
// ["active"], one that reports per-section progress passes a value per row, and a
// screen with nothing to be inside passes nothing.
export function legendOf(steps: readonly Step[], states: readonly (LegendRow["state"] | undefined)[] = []) {
  return steps.map((step, i) => ({ step: `${step.index} · ${step.kicker}`, label: step.title, state: states[i] }));
}

// A section's head: the kicker with its marks rail on one baseline, then the
// section's name in display type with its ordinal beside it, then the standfirst
// under both.
//
// Why a section needs a name at all. Every tab here is a stack of .bill-poster
// sections, and each one used to open with a single mark — a 0.72rem caps kicker
// on a hairline. That is enough on a tab that walks you through one step at a
// time and hides the rest. It is not enough on the two tabs that put every
// section on one scroll: the dashboard's four readings are all built from the same
// meters and rails, and the agents tab's four sections are all a lede pair over a
// list of rows. At that density a micro-caps kicker is not a boundary — the eye
// finds nothing to catch on, and the reader loses which section they are in.
//
// So a section says its name at a size nothing else on the page is set at. See
// "a section that names itself" in globals.css for the type and the reasoning
// behind each step of it.
//
// A fragment rather than a wrapper element, because .bill-poster rules and spaces
// its own direct children — and the padding that gives a named section its extra
// air is a `:has(> .bill-section-title)`, which only sees a child.
export function SectionHead({ marks, note, step }: { marks?: ReactNode; note: ReactNode; step: Step }) {
  return (
    <>
      <div className="bill-poster-head">
        <span className="settle-label">{step.kicker}</span>
        {marks ? <div className="bill-poster-marks">{marks}</div> : null}
      </div>
      {/* h3 under the masthead's h2. The ordinal sits inside the heading rather
          than beside it because "03 the same ledger, four ways" is what a screen
          reader should hear — a decorative digit hidden from it would leave the
          spoken outline unnumbered while the printed one counts to four. */}
      <h3 className="bill-section-title">
        <span className="bill-section-index">{step.index}</span>
        {step.title}
      </h3>
      <p className="bill-poster-note">{note}</p>
    </>
  );
}

// The poster's own entrance, shared by every tab set as one so they cannot drift.
// easeOut is --ease-out's curve spelled out: the CSS token and the JS one have to
// be the same easing, or a section that arrives with motion and then settles with
// CSS visibly changes its mind mid-gesture.
export const EASE_OUT = [0.22, 1, 0.36, 1] as const;

// A whole section arriving. The index staggers it against its siblings, so a tab
// draws itself down the page rather than snapping in as one block.
export const sectionMotion = (index: number) => ({
  animate: { opacity: 1, y: 0 },
  initial: { opacity: 0, y: 14 },
  transition: { delay: index * 0.08, duration: 0.42, ease: EASE_OUT },
});

// A block that appears inside a section rather than as one: a revealed field, a
// second reading, a warning that had nothing to warn about a moment ago.
export const revealMotion = {
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 6 },
  initial: { opacity: 0, y: 10 },
  transition: { duration: 0.26, ease: EASE_OUT },
};


// The masthead a tab opens with, in the poster's voice: no border, no fill, no
// bloom, no icon — a kicker, the title at the largest size on the page, a
// standfirst, and the contents rail.
//
// The rail indexes the sections below in the order they appear: each step is a
// .bill-cell — caps label, its line, and a rule underneath — and the rule is what
// carries progress, dim for a step not reached, at ink for one that is done, and
// lit to 2px for the step in play. That is the same gesture a focused field makes
// three sections down, which is the point: one page, one grammar.
export function PosterHero({
  eyebrow,
  title,
  lede,
  legend,
  actions,
}: {
  eyebrow: string;
  title: string;
  lede: ReactNode;
  legend: LegendRow[];
  actions?: ReactNode;
}) {
  return (
    <header className="bill-poster bill-masthead">
      <div className="bill-poster-head">
        <span className="settle-label">{eyebrow}</span>
        {actions ? <div className="bill-poster-marks">{actions}</div> : null}
      </div>
      {/* h2 for the same reason TabHero's title is one: every section below it is
          an h3/h4, so the tab reads as one outline. */}
      <h2 className="bill-masthead-title">{title}</h2>
      <p className="bill-masthead-lede">{lede}</p>
      {/* An ordered list, because the order is the promise the sections below
          keep. The rules say where you are visually; aria-current and the one
          hidden word say it to a screen reader, which a lit hairline cannot. */}
      <ol className="bill-contents">
        {legend.map((row) => (
          <li
            aria-current={row.state === "active" ? "step" : undefined}
            className="bill-cell bill-contents-entry"
            data-state={row.state}
            key={row.step}
          >
            <span className="settle-label">{row.step}</span>
            <span className="bill-contents-label">
              {row.label}
              {row.state === "done" ? <span className="sr-only"> — done</span> : null}
            </span>
            <div className="bill-cell-rule" />
          </li>
        ))}
      </ol>
    </header>
  );
}

// An editable value with no chrome, for the bill poster. A hidden mirror carries
// the same text in the same font, so the slot sizes itself to the value and the
// input lies over it — the IOU composer's trio (.iou-slot/.iou-mirror/.iou-field)
// reused verbatim. The type comes from whatever poster class wraps it, so one
// component serves a 5rem total and a 0.95rem handle.
export function PosterValue({
  ariaLabel,
  compact,
  decimal = false,
  disabled = false,
  onBlur,
  onChange,
  placeholder,
  value,
}: {
  ariaLabel: string;
  compact?: string | null;
  decimal?: boolean;
  disabled?: boolean;
  // Commit-on-blur, for a value whose owner persists it rather than holding it in
  // React state. Fires after the field has dropped what was typed, so the
  // canonical figure is already back on screen when the save goes out.
  onBlur?: () => void;
  onChange: (value: string) => void;
  placeholder: string;
  value: string;
}) {
  // What was actually typed, held only while the field has focus. Several of
  // these are fed a DERIVED value — `(subtotal * rate).toFixed(2)` — which would
  // otherwise rewrite "12." to "12.00" under the caret on the very next render.
  // Dropped on blur so the field goes back to showing the canonical figure.
  const [typed, setTyped] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const shown = typed ?? value;
  // Compaction is suspended while the field has focus, and keyed on focus rather
  // than on "has been typed in": the short form is drawn over transparent glyphs,
  // so a caret moving through text nobody can see is worse than a long line. An
  // address is pasted rather than typed, so a rendered one is compact from the
  // start and only opens up if someone goes in to edit it.
  const short = focused ? null : compact;

  return (
    <span className="iou-slot" data-compact={short ? "" : undefined}>
      <span aria-hidden className="iou-mirror">
        {short || shown || placeholder}
      </span>
      {short ? (
        <span aria-hidden className="iou-compact">
          {short}
        </span>
      ) : null}
      <input
        aria-label={ariaLabel}
        autoComplete="off"
        className="iou-field"
        disabled={disabled}
        inputMode={decimal ? "decimal" : undefined}
        onBlur={() => {
          setFocused(false);
          setTyped(null);
          onBlur?.();
        }}
        onChange={(event) => {
          const next = event.target.value;
          // Gated live rather than validated after: a figure set at 5rem with
          // junk in it reads as a broken page, not as a rejected keystroke.
          if (decimal && !typableAmount(next)) return;
          setTyped(next);
          onChange(next);
        }}
        onFocus={() => setFocused(true)}
        placeholder={placeholder}
        spellCheck={false}
        value={shown}
      />
    </span>
  );
}

// One labelled figure on the poster's rail: caps label, the value, and the rule
// that lights when the value has focus.
export function PosterCell({
  decimal = false,
  label,
  onBlur,
  onChange,
  placeholder = "0.00",
  prefix,
  value,
}: {
  decimal?: boolean;
  label: string;
  onBlur?: () => void;
  onChange: (value: string) => void;
  placeholder?: string;
  // The "$" that qualifies a money figure, dim like every other one on the page.
  // Omitted for a figure that is not money — a score out of 100 with a currency
  // mark in front of it is a lie the layout tells.
  prefix?: string;
  value: string;
}) {
  return (
    <div className="bill-cell">
      <span className="settle-label">{label}</span>
      <div className="bill-figure-sm">
        {prefix ? <span className="bill-currency">{prefix}</span> : null}
        <PosterValue
          ariaLabel={label}
          decimal={decimal}
          onBlur={onBlur}
          onChange={onChange}
          placeholder={placeholder}
          value={value}
        />
      </div>
      <div className="bill-cell-rule" />
    </div>
  );
}

// The same entry with nothing to type into it: a figure read back off the chain.
// Identical markup to PosterCell minus the input, so a rail can mix the two and
// stay one row of aligned entries — which is the whole reason the rule belongs to
// the cell rather than to the value.
//
// A warn tone is for a figure that is the PROBLEM, not merely a low number: an
// approval or a balance under what this cycle needs. The rule stays dim, because
// a lit rule on this page means focus.
//
// `note` is the one line a figure sometimes needs to be read correctly — what a
// net position is, what a share is a share OF. It goes under the rule rather than
// into a tooltip, because a figure people misread has to say what it is without
// being hovered first.
export function PosterFact({
  label,
  note,
  tone,
  value,
}: {
  label: string;
  note?: ReactNode;
  tone?: "warn";
  value: ReactNode;
}) {
  return (
    <div className="bill-cell" data-tone={tone}>
      <span className="settle-label">{label}</span>
      <div className="bill-figure-sm">{value}</div>
      <div className="bill-cell-rule" />
      {note ? <span className="bill-meter-note">{note}</span> : null}
    </div>
  );
}
