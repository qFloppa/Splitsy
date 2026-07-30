// The two shells every app tab is built from. Deliberately not a "use client"
// entry point: both are imported only by client components, and marking them one
// would force every prop to be serializable — which the ReactNode icon/chip/
// action slots are not.
//
// The styling they carry lives under "the spec-sheet system" in globals.css,
// which is also where the two rules governing it are written down: tint means
// state, and a step number is stable whether or not its card is on screen.
import type { ReactNode } from "react";

// Every section on every tab is one of these. The header carries a mono step
// ("02 · SPLIT"), the title, and an optional plain-language note, so a section
// says what it is and where it sits in the flow before you read its contents.
// `live` lights the rail and warms the header. `chip` is the section's own
// status; `action` is its controls.
export function Panel({
  title,
  step,
  icon,
  note,
  chip,
  action,
  live = false,
  children,
}: {
  title: ReactNode;
  step?: string;
  icon?: ReactNode;
  note?: ReactNode;
  chip?: ReactNode;
  action?: ReactNode;
  live?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={`spec-card ${live ? "spec-card-live" : ""}`}>
      <div className="spec-head">
        <div className="min-w-0">
          {icon || step ? (
            <span className="spec-kicker">
              {icon ? <span className="spec-icon">{icon}</span> : null}
              {step ? <span className="spec-step">{step}</span> : null}
            </span>
          ) : null}
          {/* h3, not h2: the tab's own <h2> is TabHero's title, and every card
              sits under it. Keeping the levels nested means the tab reads as one
              outline to a screen reader instead of a flat pile of h2s. */}
          <h3 className="spec-title">{title}</h3>
          {note ? <p className="spec-note">{note}</p> : null}
        </div>
        {chip || action ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {chip}
            {action}
          </div>
        ) : null}
      </div>
      <div className="spec-body">{children}</div>
    </section>
  );
}

// The masthead each tab opens with: what this tab is for, and a legend indexing
// the cards below in the order they appear. A legend row takes a state, so on the
// tabs that have a real sequence the legend doubles as a progress readout.
export function TabHero({
  eyebrow,
  icon,
  title,
  lede,
  legend,
  actions,
}: {
  eyebrow: string;
  icon: ReactNode;
  title: string;
  lede: ReactNode;
  legend: { step: string; label: string; state?: "done" | "active" }[];
  actions?: ReactNode;
}) {
  return (
    <header className="tab-hero">
      <div className="tab-hero-grid">
        <div className="min-w-0">
          <span className="tab-eyebrow">
            {icon} {eyebrow}
          </span>
          <h2 className="tab-hero-title">{title}</h2>
          <p className="tab-lede">{lede}</p>
          {actions ? <div className="tab-hero-actions">{actions}</div> : null}
        </div>
        <dl className="tab-legend">
          {legend.map((row) => (
            <div className="tab-legend-row" data-state={row.state} key={row.step}>
              <dt>{row.step}</dt>
              <dd>{row.label}</dd>
            </div>
          ))}
        </dl>
      </div>
    </header>
  );
}
