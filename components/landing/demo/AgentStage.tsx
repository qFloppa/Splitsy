"use client";

import { useRef, useState } from "react";
import { Bot, Check, Terminal, TriangleAlert } from "lucide-react";

import { ACTS, DEMO_CAP, OCR_PRICE, STEPS, THRESHOLD, TOTAL_SPEND, type Line } from "./agent-script";

/**
 * The agent-economy demo: Scout's decision signals on the left, the x402 HTTP
 * exchange on the right.
 *
 * Same authoring discipline as DemoStage — the DOM below is written in its
 * FINAL state and transient props carry opacity-0, so under
 * prefers-reduced-motion we never build a timeline and this static frame is
 * what renders. Unlike DemoStage this stage does NOT pin: two scroll-jacked
 * sections on one page is one too many, so it autoplays in view instead.
 */
export function AgentStage() {
  const stageRef = useRef<HTMLDivElement>(null);
  const [activeStep, setActiveStep] = useState(0);
  const seekRef = useRef<(index: number) => void>(() => {});

  return (
    <div className="relative grid gap-5 p-5 md:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] md:p-7" ref={stageRef}>
      <p className="sr-only">
        Animated walkthrough of an agent payment. Scout, an autonomous agent, checks that the uploaded
        receipt is legible and that its daily budget can cover the call. It requests Splitsy&apos;s OCR
        endpoint, receives an HTTP 402 Payment Required challenge quoting {OCR_PRICE} in USDC on Arc
        Testnet, signs an offchain EIP-3009 authorization instead of sending a transaction, and retries.
        Circle Gateway verifies and settles the payment, and the endpoint returns the parsed bill. The
        first parse scores 0.62 confidence, below the {THRESHOLD} threshold, so Scout pays a second time
        for a higher-quality parse and keeps the better of the two. Finally it buys a foreign-exchange
        rate to convert the total to USD, spending {TOTAL_SPEND} in all.
      </p>

      {/* LEFT · Scout's decision signals */}
      <div className="flex flex-col">
        <p className="flex items-center gap-2 text-sm font-bold text-[var(--text)]">
          <Bot className="text-[var(--accent)]" size={16} /> Scout · the buyer
        </p>

        <div className="mt-3 space-y-2">
          <Signal
            index={0}
            title="Image is legible"
            detail="1.4 MB · 1290 × 1720"
            foot="floors: 8 KB · 200 px"
          />
          <Signal
            index={1}
            title="Budget allows it"
            detail={`${DEMO_CAP} cap · ${OCR_PRICE} per call`}
            foot="the cap is the risk control"
          />
          <Signal
            index={2}
            title="Confidence"
            detail="0.94 — kept the better parse"
            foot={`below ${THRESHOLD} it buys a second opinion`}
            warnDetail={`0.62 — under ${THRESHOLD}, buying again`}
          />
        </div>

        <div className="mt-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-strong)] px-3 py-2.5">
          <p className="flex items-baseline justify-between text-xs text-[var(--text-muted)]">
            <span>Spent this run</span>
            <span className="amount-text font-bold text-[var(--text)]" data-spend>
              {TOTAL_SPEND}
            </span>
          </p>
          <p className="mt-1.5 text-[11px] text-[var(--text-muted)]" data-wallet>
            Scout signs from its own wallet — a server-held EOA on Arc with an ERC-8004 identity.
          </p>
        </div>
      </div>

      {/* RIGHT · the x402 transcript */}
      <div className="flex min-w-0 flex-col">
        <p className="flex items-center gap-2 text-sm font-bold text-[var(--text)]">
          <Terminal className="text-[var(--accent)]" size={16} /> x402 · HTTP
        </p>

        {/* A fixed-height viewport over a track the timeline slides upward, so
            the transcript behaves like a real terminal rather than overflowing:
            the six acts are ~36rem of lines in a 24rem pane. Under reduced
            motion nothing slides, so the viewport is hand-scrollable instead
            and no line is unreachable. */}
        <div className="mono mt-3 h-[24rem] overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-strong)] p-3 text-[11px] leading-[1.7] motion-reduce:overflow-y-auto sm:text-xs">
          <div data-track>
            {ACTS.map((act, actIndex) => (
              <div className="space-y-0.5" data-act={actIndex} data-act-group key={act.label}>
                {act.lines.map((line, lineIndex) => (
                  <TranscriptLine key={`${act.label}-${lineIndex}`} line={line} />
                ))}
              </div>
            ))}
          </div>
        </div>

        <p className="mt-2 text-[11px] text-[var(--text-muted)]">
          Scripted walkthrough — the field names, headers, prices and thresholds are the ones the server
          uses. The address and transaction hash are illustrative.
        </p>
      </div>

      {/* loop-reset veil */}
      <div className="pointer-events-none absolute inset-0 z-40 bg-[var(--surface)] opacity-0" data-overlay />

      {/* step rail */}
      <nav aria-label="Agent demo steps" className="col-span-full mt-1 flex flex-wrap items-center justify-center gap-1.5">
        {STEPS.map((step, i) => (
          <button
            className={`rounded-full px-3 py-1 text-xs font-bold transition-colors duration-[var(--dur-1)] ${
              i === activeStep
                ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                : "text-[var(--text-muted)] hover:text-[var(--text)]"
            }`}
            key={step}
            onClick={() => {
              setActiveStep(i);
              seekRef.current(i);
            }}
            type="button"
          >
            {step}
          </button>
        ))}
      </nav>
    </div>
  );
}

// One decision signal. Signal 3 carries two mutually exclusive detail lines —
// the amber "under threshold" reading and the resolved green one — because
// swapping textContent from a timeline does not survive scrubbing backwards,
// whereas toggling two elements with tl.set() reverts cleanly.
function Signal({
  index,
  title,
  detail,
  foot,
  warnDetail,
}: {
  index: number;
  title: string;
  detail: string;
  foot: string;
  warnDetail?: string;
}) {
  return (
    <div
      className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 data-[state=warn]:border-[var(--warning-text)]"
      data-signal
      data-signal-index={index}
      data-state="ok"
    >
      <p className="flex items-center gap-2 text-xs font-bold text-[var(--text)]">
        {/* Both glyphs share one slot so swapping them cannot shift the title.
            They stack absolutely rather than toggling `hidden`, because the
            timeline crossfades them with autoAlpha and a display:none element
            cannot be tweened back in. */}
        <span className="relative inline-flex size-[13px] shrink-0 items-center justify-center">
          <span className="absolute inset-0 text-[var(--success)]" data-signal-ok>
            <Check size={13} />
          </span>
          {warnDetail ? (
            <span
              aria-hidden="true"
              className="absolute inset-0 text-[var(--warning-text)] opacity-0"
              data-signal-warn
            >
              <TriangleAlert size={13} />
            </span>
          ) : null}
        </span>
        {title}
      </p>
      <p className="mt-1 text-xs text-[var(--text-muted)]" data-signal-detail>
        {detail}
      </p>
      {/* Authored hidden from assistive tech as well as from sight: opacity-0
          alone would have a screen reader announce both mutually exclusive
          confidence readings as if both were current. Task 4's timeline flips
          this attribute alongside the crossfade. */}
      {warnDetail ? (
        <p
          aria-hidden="true"
          className="mt-1 text-xs text-[var(--warning-text)] opacity-0"
          data-signal-warn-detail
        >
          {warnDetail}
        </p>
      ) : null}
      <p className="mt-1 text-[11px] text-[var(--text-muted)]">{foot}</p>
    </div>
  );
}

// Act membership comes from the wrapping [data-act-group], so a line only
// needs to mark itself animatable.
function TranscriptLine({ line }: { line: Line }) {
  const common = "flex items-baseline gap-2";

  if (line.kind === "req") {
    return (
      <p className={`${common} text-[var(--accent)]`} data-line>
        <span aria-hidden="true">→</span>
        <span className="min-w-0 break-all font-semibold">{line.text}</span>
      </p>
    );
  }

  if (line.kind === "res") {
    return (
      <p className={`${common} text-[var(--success)]`} data-line>
        <span aria-hidden="true">←</span>
        <span className="min-w-0 break-all font-semibold">{line.text}</span>
      </p>
    );
  }

  if (line.kind === "note") {
    return (
      <p className="pl-4 text-[var(--text-muted)]" data-line>
        {line.text}
      </p>
    );
  }

  if (line.kind === "check") {
    return (
      <p className={`${common} pl-4`} data-line>
        <span className={line.state === "warn" ? "text-[var(--warning-text)]" : "text-[var(--success)]"}>
          {line.state === "warn" ? "!" : "✓"}
        </span>
        <span className="text-[var(--text-muted)]">{line.text}</span>
        <span className="min-w-0 flex-1 break-all text-right text-[var(--text)]">{line.value}</span>
      </p>
    );
  }

  return (
    <p className={`${common} pl-4`} data-line>
      <span className="shrink-0 text-[var(--text-muted)]">{line.text}</span>
      <span className="min-w-0 flex-1 break-all text-right text-[var(--text)]">{line.value}</span>
      {line.note ? <span className="shrink-0 text-[var(--text-muted)]">{line.note}</span> : null}
    </p>
  );
}
