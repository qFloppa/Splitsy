"use client";

import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { Bot, Check, ExternalLink, Terminal, TriangleAlert } from "lucide-react";

import { resolveLedger, SCRIPTED_LEDGER, type LedgerTiles } from "@/lib/landing-ledger";

import {
  ACTS,
  DEMO_CAP,
  OCR_PRICE,
  STEP_LABELS,
  STEPS,
  THRESHOLD,
  TOTAL_SPEND,
  type Line,
} from "./agent-script";

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
  const [ledger, setLedger] = useState<LedgerTiles>(SCRIPTED_LEDGER);
  const [agent, setAgent] = useState<{ address: string; tokenId: string | null } | null>(null);

  // One fetch, no polling: this is a marketing page, not the dashboard. A
  // failure is silent by design — the scripted figures already on screen stay
  // put, and the "live" dot simply never appears.
  useEffect(() => {
    let live = true;
    fetch("/api/scout/stats")
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (!live) return;
        setLedger(resolveLedger(payload));
        const found = payload?.agent;
        if (found?.address) setAgent({ address: found.address, tokenId: found.tokenId ?? null });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const stage = stageRef.current;
    if (!stage) return;

    let ctx: gsap.Context | undefined;
    let tickFn: (() => void) | undefined;
    let stepIndex = 0;

    const build = () => {
      if (tickFn) gsap.ticker.remove(tickFn);
      tickFn = undefined;
      ctx?.revert();

      ctx = gsap.context(() => {
        const q = gsap.utils.selector(stage);
        const el = (sel: string) => q(sel)[0];

        const signals = q("[data-signal]");
        const overlay = el("[data-overlay]");
        const spendOut = el("[data-spend]");
        const track = el("[data-track]");
        const groups = q("[data-act-group]");
        const viewport = track.parentElement as HTMLElement;
        const confidence = signals[2];
        const confOk = confidence.querySelector("[data-signal-ok]");
        const confWarn = confidence.querySelector("[data-signal-warn]");
        const confDetail = confidence.querySelector("[data-signal-detail]");
        const confWarnDetail = confidence.querySelector("[data-signal-warn-detail]");

        // ---- reset to the starting frame ----
        // autoAlpha uses visibility, not display, so hidden lines still occupy
        // layout and the offsets measured below are the final ones.
        gsap.set(track, { y: 0 });
        gsap.set(q("[data-line]"), { autoAlpha: 0, y: 5 });
        gsap.set(signals, { autoAlpha: 0, y: 8 });
        gsap.set(overlay, { autoAlpha: 0 });
        gsap.set(confOk, { autoAlpha: 0 });
        gsap.set(confDetail, { autoAlpha: 0 });
        // The warn pair is hidden from assistive tech as well as from sight:
        // visibility:hidden would do it, but these two are crossfaded by opacity
        // against their green siblings, so the attribute carries the semantics.
        gsap.set([confWarn, confWarnDetail], { autoAlpha: 0, attr: { "aria-hidden": "true" } });

        // How far the track must slide so act i's last line sits just inside
        // the viewport's bottom edge. Clamped at 0 so early acts never scroll.
        const trackTop = track.getBoundingClientRect().top;
        const groupBottoms = groups.map((g) => g.getBoundingClientRect().bottom - trackTop);
        const viewInner = viewport.clientHeight - 24; // p-3 top + bottom
        const scrollFor = (i: number) => -Math.max(0, groupBottoms[i] - viewInner);

        // The spend counter is a tweened proxy rather than a sequence of
        // textContent writes, so scrubbing backwards unwinds it correctly.
        const spend = { usd: 0 };
        const renderSpend = () => {
          spendOut.textContent = `$${spend.usd.toFixed(3)}`;
        };
        renderSpend();

        const tl = gsap.timeline({ paused: true });

        ACTS.forEach((act, actIndex) => {
          tl.addLabel(act.label);

          // Signals 1 and 2 are the pre-flight gates: both fire before a cent
          // is spent, which is the whole point of the first act.
          if (actIndex === 0) {
            tl.to([signals[0], signals[1]], {
              autoAlpha: 1,
              y: 0,
              duration: 0.4,
              ease: "expo.out",
              stagger: 0.18,
            });
          }

          // Signal 3 appears amber when the parse comes back unsure, then
          // resolves green once the second opinion is in. Both transitions use
          // tl.set() on two sibling elements so reverse playback restores them.
          if (actIndex === 4) {
            tl.to(confidence, { autoAlpha: 1, y: 0, duration: 0.4, ease: "expo.out" })
              .set(confidence, { attr: { "data-state": "warn" } }, "<")
              .set([confWarn, confWarnDetail], { autoAlpha: 1, attr: { "aria-hidden": "false" } }, "<");
          }

          // Slide the track first so the incoming act has room, then reveal it.
          tl.to(track, { y: scrollFor(actIndex), duration: 0.45, ease: "power2.inOut" }).to(
            groups[actIndex].querySelectorAll("[data-line]"),
            { autoAlpha: 1, y: 0, duration: 0.3, ease: "power2.out", stagger: 0.14 },
            "-=0.25",
          );

          // Money moves as its ledger line lands, not before.
          if (actIndex === 3 || actIndex === 4) {
            tl.to(
              spend,
              { usd: `+=${parseFloat(OCR_PRICE.replace("$", ""))}`, duration: 0.4, onUpdate: renderSpend },
              "<",
            );
          }
          if (actIndex === 5) {
            tl.to(
              spend,
              { usd: parseFloat(TOTAL_SPEND.replace("$", "")), duration: 0.4, onUpdate: renderSpend },
              "<",
            );
          }

          if (actIndex === 4) {
            tl.set(confidence, { attr: { "data-state": "ok" } })
              .set([confWarn, confWarnDetail], { autoAlpha: 0, attr: { "aria-hidden": "true" } }, "<")
              .set([confOk, confDetail], { autoAlpha: 1 }, "<");
          }

          tl.to({}, { duration: actIndex === ACTS.length - 1 ? 1.6 : 0.55 });
        });

        tl.to(overlay, { autoAlpha: 1, duration: 0.5, ease: "power2.in" }).to(overlay, {
          autoAlpha: 0,
          duration: 0.01,
        });

        // ---- drive: autoplay while on screen ----
        // No pin and no scrub. DemoStage already scroll-jacks this page once;
        // a second pinned section would make the scroll feel taken away.
        let inView = false;
        let seeking = false;

        // ---- rail highlighting ----
        // Muted while seeking: a seek tween scrubs through every intervening
        // label, and announcing each one walks the highlight to the step the
        // user clicked the long way round.
        const labelTimes = STEP_LABELS.map((label) => tl.labels[label] / tl.duration());
        tl.eventCallback("onUpdate", () => {
          if (seeking) return;
          const p = tl.progress();
          let idx = 0;
          for (let i = 0; i < labelTimes.length; i++) if (p >= labelTimes[i]) idx = i;
          if (idx !== stepIndex) {
            stepIndex = idx;
            setActiveStep(idx);
          }
        });

        const io = new IntersectionObserver(([entry]) => (inView = entry.isIntersecting), {
          threshold: 0.15,
        });
        io.observe(stage);

        tickFn = () => {
          if (!inView || seeking) return;
          tl.progress((tl.progress() + gsap.ticker.deltaRatio(60) / 60 / tl.duration()) % 1);
        };
        gsap.ticker.add(tickFn);

        seekRef.current = (index: number) => {
          seeking = true;
          stepIndex = index; // the rail's own onClick already highlighted it
          gsap.to(tl, {
            progress: labelTimes[index] + 0.001,
            duration: 0.6,
            ease: "power2.inOut",
            overwrite: true, // a second click kills the first seek rather than racing it
            onComplete: () => {
              seeking = false;
            },
          });
        };

        return () => io.disconnect();
      }, stage);
    };

    build();

    let resizeTimer: ReturnType<typeof setTimeout>;
    let lastWidth = stage.clientWidth;
    const ro = new ResizeObserver(() => {
      if (stage.clientWidth === lastWidth) return; // height changes as lines reveal; only width needs a rebuild
      lastWidth = stage.clientWidth;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(build, 250);
    });
    ro.observe(stage);

    return () => {
      ro.disconnect();
      clearTimeout(resizeTimer);
      if (tickFn) gsap.ticker.remove(tickFn);
      ctx?.revert();
    };
  }, []);

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
          <Signal title="Image is legible" detail="1.4 MB · 1290 × 1720" foot="floors: 8 KB · 200 px" />
          <Signal
            title="Budget allows it"
            detail={`${DEMO_CAP} cap · ${OCR_PRICE} per call`}
            foot="the cap is the risk control"
          />
          <Signal
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
            Signed from Scout&apos;s own wallet — a server-held EOA on Arc, capped at {DEMO_CAP} a day.
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

      {/* LIVE · the real x402 ledger, not the scripted run above */}
      <div className="col-span-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--text-muted)]">
            {ledger.live ? (
              <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-[var(--success)] motion-reduce:animate-none" />
            ) : null}
            {ledger.live ? "Live from the x402 ledger" : "Agent economy · all time"}
          </p>
          {agent ? (
            <a
              className="inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)]"
              href={`https://testnet.arcscan.app/address/${agent.address}`}
              rel="noreferrer"
              target="_blank"
            >
              Scout {agent.address.slice(0, 6)}…{agent.address.slice(-4)}
              {agent.tokenId ? ` · ERC-8004 #${agent.tokenId}` : ""}
              <ExternalLink size={11} />
            </a>
          ) : null}
        </div>

        <div className="mt-2 grid grid-cols-3 gap-3">
          <LedgerTile label="Earned" sub="x402 calls served" value={`${ledger.earnedUsdc} USDC`} />
          <LedgerTile label="Scout spent" sub="paid to Splitsy's own APIs" value={`${ledger.spentUsdc} USDC`} />
          <LedgerTile label="Calls served" sub="paid API responses" value={ledger.callsServed} />
        </div>
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
  title,
  detail,
  foot,
  warnDetail,
}: {
  title: string;
  detail: string;
  foot: string;
  warnDetail?: string;
}) {
  return (
    <div
      className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 data-[state=warn]:border-[var(--warning-text)]"
      data-signal
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
          confidence readings as if both were current. The timeline flips this
          attribute alongside the crossfade, so whichever reading is on screen
          is the one that is exposed. */}
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

function LedgerTile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="min-w-0">
      <p className="amount-text truncate text-base font-bold tabular-nums text-[var(--text)] sm:text-lg">{value}</p>
      <p className="truncate text-[11px] font-semibold text-[var(--text)]">{label}</p>
      <p className="truncate text-[11px] text-[var(--text-muted)]">{sub}</p>
    </div>
  );
}
