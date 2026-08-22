"use client";

// The dashboard, set as a poster.
//
// This was the last screen on the spec-card system, which meant the one tab
// whose entire job is to be read was also the only one that read as a different
// product. It is a poster now — see "the dashboard poster" in globals.css, which
// carries the reasoning for every class used here.
//
// One observation does most of the work: a horizontal bar chart IS a labelled
// figure with a proportional rule under it. So every categorical breakdown —
// identity, counterparties, settlement state, aging, recurring cycles — is drawn
// with this page's own hairline (.bill-meter-rule), and only the two genuine time
// series stay plotted. Two consequences worth stating:
//
//   1. No table toggle on a breakdown. The old ChartCard offered one because a
//      recharts bar encodes its value in pixels; a meter states its number in
//      type beside its label, so the rows already ARE the table. Only the two
//      plots keep the toggle, because only they hide their numbers in a curve.
//   2. Colour is never load-bearing. The identity hue tints a rule that already
//      has its figure written next to it, so the CVD-validated palette is
//      decoration on top of text rather than the only way to read the chart.
//
// The one thing a poster of this density needs that the other tabs do not is a
// section that says its own name. Bills walks you through its steps one at a
// time; this tab stacks four readings built from the same meters and rails on one
// scroll, and a 0.72rem caps kicker cannot mark a boundary between two of those.
// So each section prints its ordinal and a title in display type — see
// SectionHead below and "a section that names itself" in globals.css — and both
// the title and the masthead's contents rail read from one table of steps, so the
// index and the page can never name a reading differently.
//
// The money logic is untouched from the card version: same fetch, same
// stale-while-revalidate cache, same filters, same settle path. Only the
// presentation moved.
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Area, AreaChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  IDENTITY_BUCKETS,
  type DashboardData,
  type IdentityBucket,
  type TreasuryPlan,
  type TreasurySettleSelection,
} from "@/lib/dashboard-types";
import { providerDisplay } from "@/lib/provider-display";
import type { IdentityProvider } from "@/lib/types";
import { ProviderIcon } from "./ProviderTag";
import { PosterFact, PosterHero, SectionHead, legendOf, revealMotion, sectionMotion, type Step } from "./SpecCard";

type RangeKey = "7d" | "30d" | "90d" | "all";
// Which of the user's wallet identities the dashboard reports on. "all" unions
// the social (custodial DCW) and non-custodial (browser) wallets.
type Scope = "all" | "social" | "wallet";

const EXPLORER = "https://testnet.arcscan.app";
const RANGE_DAYS: Record<Exclude<RangeKey, "all">, number> = { "7d": 7, "30d": 30, "90d": 90 };
const BUCKET_LABEL: Record<IdentityBucket, string> = {
  x: "X",
  discord: "Discord",
  email: "Email",
  wallet: "Wallet",
  unknown: "Unknown",
};

// USDC amounts arrive as decimal strings; Number() for math, format with a $.
const num = (v: string | number) => Number(v) || 0;
const usd = (v: string | number) =>
  `$${num(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
// The figure without its currency mark, for the two places the "$" is set
// separately as a dim qualifier (.bill-currency) rather than run into the number.
const fig = (v: string | number) => num(v).toLocaleString(undefined, { maximumFractionDigits: 2 });
// `many` for the words whose plural is not the singular plus an s. There are only
// two on this tab, and getting "counterpartys" onto a poster would undo a lot of
// careful type.
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// A counterparty arrives as a label with no address beside it (see Counterparty
// in lib/dashboard-types.ts), so "is this a person or a raw address" is a question
// about the label itself.
const isAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s);

// weekStart buckets are epoch-aligned 7-day windows (Thursday-anchored, NOT ISO
// Monday weeks) — format the date plainly, never "week of Monday…".
function fmtWeek(iso: string) {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}
function fmtDay(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function shortAddr(a: string) {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
// A share of a total, for the footnote under a meter. Suppressed at zero rather
// than printed as "0% of billed", which reads as a measurement of nothing.
function share(value: number, total: number) {
  return total > 0 ? `${Math.round((value / total) * 100)}%` : null;
}

// Panel-local presentation filter. Identity buckets attribute only byIdentity and
// topCounterparties (the chain carries no bucket on the KPI/status/aging totals),
// so those two + a derived volume subtotal refilter on bucket selection; range
// windows the activity series. Money-of-record math stays in lib/dashboard-aggregate.
type Filtered = {
  activity: DashboardData["activity"];
  byIdentity: DashboardData["byIdentity"];
  topCounterparties: DashboardData["topCounterparties"];
  filteredVolumeUsdc: number;
  filteredBillCount: number;
  bucketsActive: boolean;
};

function applyFilters(data: DashboardData, range: RangeKey, buckets: Set<IdentityBucket>): Filtered {
  const bucketsActive = buckets.size > 0;
  const keep = (b: IdentityBucket) => !bucketsActive || buckets.has(b);

  const byIdentity = data.byIdentity.filter((s) => keep(s.bucket));
  const topCounterparties = data.topCounterparties.filter((c) => keep(c.bucket));

  let activity = data.activity;
  if (range !== "all" && activity.length) {
    const maxMs = Math.max(...activity.map((p) => Date.parse(p.weekStart)));
    const cutoff = maxMs - RANGE_DAYS[range] * 86_400_000;
    activity = activity.filter((p) => Date.parse(p.weekStart) >= cutoff);
  }

  return {
    activity,
    byIdentity,
    topCounterparties,
    filteredVolumeUsdc: byIdentity.reduce((s, x) => s + num(x.volumeUsdc), 0),
    filteredBillCount: byIdentity.reduce((s, x) => s + x.billCount, 0),
    bucketsActive,
  };
}

function isAllZero(d: DashboardData) {
  const k = d.kpis;
  const noMoney =
    num(k.createdTotalUsdc) === 0 &&
    num(k.claimableUsdc) === 0 &&
    num(k.owedToMeOutstandingUsdc) === 0 &&
    num(k.iOweOutstandingUsdc) === 0;
  return k.createdCount === 0 && d.recurring.length === 0 && d.reputation.count === 0 && noMoney;
}

// ── stale-while-revalidate cache ─────────────────────────────────────────────
// Switching tabs unmounts this panel, so a naive fetch re-runs on every return.
// We stash the last response per fetch key and paint it instantly on remount /
// scope change while a background refetch keeps it fresh. The key is the exact
// query the effect issues, so each scope (social / wallet / all) and demo have
// distinct entries — a switch never shows another scope's numbers.
const CACHE_PREFIX = "splitsy:dashboard:";

function cacheKeyFor(demo: boolean, walletsParam: string): string {
  return demo ? "demo" : walletsParam;
}

// walletsParam for a given scope, matching the render-time derivation below.
// Standalone so handlers and the initial-state seed can compute a target scope's
// key without waiting for the next render.
function walletsParamFor(scope: Scope, socialWallet: string | null, browserWallet: string | null): string {
  const list =
    scope === "social" ? [socialWallet] : scope === "wallet" ? [browserWallet] : [socialWallet, browserWallet];
  return list.filter(Boolean).join(",");
}

function readDashboardCache(key: string): DashboardData | null {
  if (!key || typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(CACHE_PREFIX + key);
    return raw ? (JSON.parse(raw) as DashboardData) : null;
  } catch {
    return null; // malformed/unavailable — treat as a miss
  }
}

function writeDashboardCache(key: string, data: DashboardData): void {
  if (!key || typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(CACHE_PREFIX + key, JSON.stringify(data));
  } catch {
    // quota or serialization failure — the cache is best-effort, so skip.
  }
}

// ── the poster's own parts ───────────────────────────────────────────────────

// A rule cannot draw itself to a length it was born with, so the first painted
// frame has to be the empty one. Two frames, not one: an effect can land inside
// the same paint as the commit that scheduled it, and a meter that arrives at
// full length is a meter that never animated.
//
// It gates on mount only. Re-drawing every rule on each filter change would turn
// a one-word toggle into a full redraw of the page, which reads as a reload
// rather than as a filter.
function useDrawn() {
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setDrawn(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, []);
  return drawn ? "true" : "false";
}

// The three custom properties .bill-meter-rule reads: how far to draw, in which
// ink, and how long to wait so a block draws itself down the page. Stringified
// because a custom property is passed through verbatim and a bare number would
// be a gamble on React's unit handling.
function meterStyle(fraction: number, index: number, ink?: string): CSSProperties {
  return {
    "--meter": String(Math.max(0, Math.min(1, fraction))),
    "--meter-index": String(index),
    ...(ink ? { "--meter-ink": ink } : {}),
  } as CSSProperties;
}

type MeterRow = {
  key: string;
  // The label carries its own swatch when the row has an identity hue, so it is
  // a node rather than a string.
  label: ReactNode;
  // The number, not the rendering of it. Both the figure and the length of the
  // rule are derived from this one value, which is the only way to guarantee they
  // agree — reading the fraction back out of the printed string would work in en
  // and quietly draw every rule empty in a locale that groups with dots.
  value: number;
  format?: (n: number) => string;
  note?: ReactNode;
  ink?: string;
  // Present → the whole entry is the filter for itself.
  onClick?: () => void;
  active?: boolean;
  pressed?: boolean;
  ariaLabel?: string;
};

// One breakdown: rows down the page, each rule drawn to its share of the largest
// row. Scaled to the max rather than to the sum, because the question a
// breakdown answers is "which of these is biggest", and a share-of-total scale
// leaves every row of a flat distribution as a stub.
//
// `max` overrides that for a block whose rows are progress rather than
// comparison: three tabs all half-run are all half-drawn, not all full.
function Meters({ rows, max }: { rows: MeterRow[]; max?: number }) {
  const ceiling = max ?? Math.max(...rows.map((r) => Math.abs(r.value)), 0);
  return (
    <div className="bill-meters">
      {rows.map((row, i) => (
        <Meter index={i} key={row.key} max={ceiling} row={row} />
      ))}
    </div>
  );
}

function Meter({ index, max, row }: { index: number; max: number; row: MeterRow }) {
  const value = Math.abs(row.value);
  const body = (
    <>
      <span className="bill-payer-line">
        <span className="settle-label">{row.label}</span>
        <span className="bill-figure-sm">{(row.format ?? usd)(row.value)}</span>
      </span>
      <div className="bill-meter-rule" style={meterStyle(max > 0 ? value / max : 0, index, row.ink)} />
      {row.note ? <span className="bill-meter-note">{row.note}</span> : null}
    </>
  );

  if (!row.onClick) return <div className="bill-cell">{body}</div>;
  return (
    <button
      aria-label={row.ariaLabel}
      aria-pressed={row.pressed}
      className="bill-cell bill-meter-cell"
      data-active={row.active === false ? "false" : undefined}
      onClick={row.onClick}
      type="button"
    >
      {body}
    </button>
  );
}

// A block inside a section: "who you reached" and "who you split with" are the
// same question asked twice, and neither is a section of its own. An h4 under the
// section's h3, so the tab's outline matches the type — a reader tabbing by
// heading gets the same four-then-blocks shape a reader looking at it does.
function Subhead({ children }: { children: ReactNode }) {
  return (
    <div className="bill-subhead">
      <h4 className="settle-label">{children}</h4>
    </div>
  );
}

// ── the four readings, named once ────────────────────────────────────────────
//
// Both the section titles below and the masthead's contents rail read from these
// rows — see SectionHead in SpecCard.tsx for why a section on this tab has to name
// itself at all, and "a section that names itself" in globals.css for the type.
const ANALYTICS_STEPS: readonly Step[] = [
  { index: "01", kicker: "Totals", title: "What you have billed" },
  { index: "02", kicker: "Activity", title: "Billed against settled" },
  { index: "03", kicker: "Breakdowns", title: "The same ledger, four ways" },
  { index: "04", kicker: "Behaviour", title: "How you settle up" },
];

const TREASURY_STEPS: readonly Step[] = [
  { index: "01", kicker: "Netting", title: "Who really owes whom" },
  { index: "02", kicker: "Legs", title: "The transfers left to make" },
  { index: "03", kicker: "Settle", title: "What one click will do" },
];

// The same numbers as text, for the two readings that hide theirs in a curve.
function PosterTable({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <div className="bill-table-wrap">
      <table className="bill-table">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri}>
              {r.map((c, ci) => (
                <td key={ci}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// A word that is a control. The poster draws no boxes, so a segmented control is
// a row of these and "on" is the word going to ink with a rule under it.
function Toggle({
  children,
  current,
  disabled,
  onClick,
  pressed,
  label,
}: {
  children: ReactNode;
  // Reading this one of a pair (a view, a range) vs. having switched it on.
  current?: boolean;
  disabled?: boolean;
  onClick: () => void;
  pressed?: boolean;
  label?: string;
}) {
  return (
    <button
      aria-current={current ? "true" : undefined}
      aria-label={label}
      aria-pressed={pressed}
      className="iou-provider bill-toggle"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

// Chart or table, swapped rather than cut: the outgoing reading leaves before the
// incoming one arrives, so the section's height changes once instead of twice.
function Reading({ children, table, showTable }: { children: ReactNode; table: ReactNode; showTable: boolean }) {
  return (
    <AnimatePresence initial={false} mode="wait">
      <motion.div key={showTable ? "table" : "chart"} {...revealMotion}>
        {showTable ? table : children}
      </motion.div>
    </AnimatePresence>
  );
}

// Recharts' own entrance, in the poster's easing. A series that draws itself in
// the same 700ms a meter takes is the page keeping one tempo.
const PLOT_MOTION = { animationBegin: 120, animationDuration: 700, animationEasing: "ease-out" } as const;

// socialWallet = the Circle DCW address from social login (X/Discord/email);
// browserWallet = the connected non-custodial wallet. Either may be null. The
// scope selector appears only when both exist.
export default function DashboardPanel({
  socialWallet = null,
  browserWallet = null,
  socialProvider = null,
  socialHandle = null,
  onSettleNet,
}: {
  socialWallet?: string | null;
  browserWallet?: string | null;
  // The signed-in identity behind socialWallet, so the scope selector can name
  // it ("@alice" + platform badge) instead of the generic word "Social".
  socialProvider?: IdentityProvider | null;
  socialHandle?: string | null;
  // Settle from the connected browser wallet. Owned by HomeClient, which holds
  // the wallet client and the progress modal; undefined when none is connected.
  onSettleNet?: (selection: TreasurySettleSelection) => Promise<string | void>;
}) {
  const hasSocial = Boolean(socialWallet);
  const hasWallet = Boolean(browserWallet);
  const bothIdentities = hasSocial && hasWallet;
  // With one identity, the scope is forced to it; the selector only shows when
  // both exist. "all" unions the two.
  const initialScope: Scope = bothIdentities ? "all" : hasSocial ? "social" : "wallet";

  const [demo, setDemo] = useState(false);
  const [range, setRange] = useState<RangeKey>("30d");
  const [scope, setScope] = useState<Scope>(initialScope);
  const [buckets, setBuckets] = useState<Set<IdentityBucket>>(new Set());
  const [view, setView] = useState<"analytics" | "treasury">("analytics");
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Seed from cache so returning to the tab paints instantly (the effect below
  // still refetches to revalidate). Runs client-side only — the panel mounts on
  // tab click, well after hydration — so there's no SSR/cache mismatch.
  const [data, setData] = useState<DashboardData | null>(() =>
    readDashboardCache(walletsParamFor(initialScope, socialWallet, browserWallet)),
  );

  const effectiveScope: Scope = bothIdentities ? scope : initialScope;
  const walletsParam = walletsParamFor(effectiveScope, socialWallet, browserWallet);

  // Nothing to report on: signed out AND no wallet connected (derived, no state —
  // the connect card renders from this and the effect skips fetching).
  const noWallet = !demo && !walletsParam;

  useEffect(() => {
    if (!demo && !walletsParam) return;
    let alive = true;
    const key = cacheKeyFor(demo, walletsParam);
    // Read (not write) inside the effect is fine — decides error handling only.
    const hadCache = Boolean(readDashboardCache(key));
    const qs = demo ? "?demo=1" : `?wallets=${encodeURIComponent(walletsParam)}`;
    fetch(`/api/dashboard${qs}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: DashboardData) => {
        writeDashboardCache(key, d);
        if (alive) {
          setData(d);
          setError(null); // clear a stale error after a scope/wallet change refetch
        }
      })
      .catch((e) => {
        // Keep showing cached data on a failed revalidation; only fall back to
        // the error screen when there's nothing cached for this scope.
        if (alive && !hadCache) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [demo, reloadKey, walletsParam]);

  // Reset synchronously from the events that trigger a refetch, not inside the
  // effect (avoids react-hooks/set-state-in-effect). Seed from the target key's
  // cache: a cache hit paints instantly, a miss nulls data to re-show the skeleton.
  function reload() {
    setData(readDashboardCache(cacheKeyFor(demo, walletsParam)));
    setError(null);
    setReloadKey((k) => k + 1);
  }
  function toggleDemo() {
    const nextDemo = !demo;
    setData(readDashboardCache(cacheKeyFor(nextDemo, walletsParam)));
    setError(null);
    setDemo(nextDemo);
  }
  function pickScope(s: Scope) {
    // s becomes effectiveScope (the selector only shows when both identities
    // exist), so compute its walletsParam directly for the cache lookup.
    setData(readDashboardCache(walletsParamFor(s, socialWallet, browserWallet)));
    setError(null);
    setScope(s);
  }

  const filtered = useMemo(() => (data ? applyFilters(data, range, buckets) : null), [data, range, buckets]);

  function toggleBucket(b: IdentityBucket) {
    setBuckets((prev) => {
      const next = new Set(prev);
      if (next.has(b)) next.delete(b);
      else next.add(b);
      return next;
    });
  }

  // No wallet at all (signed out + nothing connected): guide, don't alarm.
  if (noWallet) {
    return (
      <StateShell
        action={{ label: "view sample data", onClick: toggleDemo }}
        eyebrow="Signed out"
        lede="The dashboard reports on wallets, so it needs to know which ones are yours before it can report anything. Either identity works, and if you have both it can report on them together or one at a time."
        note="Sign in, or connect a wallet. Nothing here is computed until one of them is available to read."
        title="Nothing to report yet"
      />
    );
  }

  if (error) {
    return (
      <StateShell
        action={{ label: "try again", onClick: reload }}
        eyebrow="Couldn't load"
        lede="Nothing is wrong with your bills — this is the dashboard failing to read them."
        note={
          error.includes("401")
            ? "Your session has expired. Sign in again and the dashboard will reload."
            : "The request failed. This is usually momentary, so trying again is the right first move."
        }
        title="The analytics didn't come back"
      />
    );
  }

  if (!data || !filtered) return <DashboardSkeleton />;

  const showEmpty = !data.isDemo && isAllZero(data);
  const treasury = view === "treasury";

  return (
    <div className="space-y-5">
      <PosterHero
        actions={
          <>
            {/* Two tiers, not one rail of equals. Which of the two documents you
                are reading is a different kind of question from how that document
                is filtered, so the view pair is set a register up and everything
                that filters it is ruled off beside it. Only offered when there is
                a treasury plan to show — a toggle to an empty view is a dead end. */}
            {data.treasury ? (
              <span className="bill-views">
                <Toggle current={!treasury} onClick={() => setView("analytics")}>
                  analytics
                </Toggle>
                <Toggle current={treasury} onClick={() => setView("treasury")}>
                  net settlement
                </Toggle>
              </span>
            ) : null}
            <span className="bill-filters" data-ruled={data.treasury ? "true" : undefined}>
              {bothIdentities && !demo
                ? (["all", "social", "wallet"] as Scope[]).map((s) => (
                    <Toggle current={effectiveScope === s} key={s} onClick={() => pickScope(s)}>
                      <ScopeLabel
                        browserWallet={browserWallet}
                        scope={s}
                        socialHandle={socialHandle}
                        socialProvider={socialProvider}
                      />
                    </Toggle>
                  ))
                : null}
              <Toggle onClick={toggleDemo} pressed={demo}>
                sample data
              </Toggle>
              {data.isDemo ? (
                <span className="settle-label" data-tone="warn">
                  figures are invented
                </span>
              ) : null}
            </span>
          </>
        }
        eyebrow={treasury ? "Net settlement" : "Your numbers"}
        legend={legendOf(treasury ? TREASURY_STEPS : ANALYTICS_STEPS, ["active"])}
        lede={
          treasury
            ? "Debts between the same people cancel out. This view collapses every open bill into the smallest set of transfers that clears the whole web, then shows you how many payments that saves."
            : "Read across both of your wallets or one at a time. Every figure is computed from bills already on Arc — nothing here is projected, and every breakdown states its number in type, so no reading depends on telling two colours apart."
        }
        title={treasury ? "Settle everything at once" : "Where your money went"}
      />

      {treasury && data.treasury ? (
        <TreasurySection
          bothIdentities={bothIdentities}
          isDemo={data.isDemo}
          onSettleNet={onSettleNet}
          onSettled={reload}
          scope={effectiveScope}
          treasury={data.treasury}
        />
      ) : showEmpty ? (
        <EmptyState onDemo={toggleDemo} />
      ) : (
        <>
          <TotalsSection data={data} filtered={filtered} />
          <ActivitySection filtered={filtered} range={range} setRange={setRange} />
          <BreakdownsSection
            buckets={buckets}
            clearBuckets={() => setBuckets(new Set())}
            data={data}
            filtered={filtered}
            toggleBucket={toggleBucket}
          />
          <BehaviourSection data={data} />
        </>
      )}
    </div>
  );
}

// ── the masthead's scope control ─────────────────────────────────────────────

// Fallbacks for the scope selector: used when the identity behind a scope can't
// be named (no handle on the session, no connected address).
const SCOPE_LABEL: Record<Scope, string> = { all: "All", social: "Social", wallet: "Non-custodial" };

// The scope selector names each wallet rather than describing its custody model:
// the social scope reads as the signed-in handle behind its platform badge, the
// wallet scope as the connected address, compacted.
function ScopeLabel({
  scope,
  socialProvider,
  socialHandle,
  browserWallet,
}: {
  scope: Scope;
  socialProvider: IdentityProvider | null;
  socialHandle: string | null;
  browserWallet: string | null;
}) {
  if (scope === "social" && socialHandle) {
    const d = providerDisplay({ provider: socialProvider, handle: socialHandle });
    return (
      // Not .bill-payer-mark: that sizes a mark to 0.64em of its line, which on a
      // 0.72rem caps control is about seven pixels of logo. On the marks rail the
      // glyph stays at its own size and the words shrink instead.
      <span className="inline-flex items-center gap-1.5">
        <ProviderIcon provider={d.provider} size={12} />
        <span className="max-w-[13ch] truncate">
          {d.prefix}
          {d.label}
        </span>
      </span>
    );
  }
  if (scope === "wallet" && browserWallet) return <>{shortAddr(browserWallet)}</>;
  return <>{SCOPE_LABEL[scope]}</>;
}

// ── readings ────────────────────────────────────────────────────────────────

// 01. The headline figures. Two of them are set as the poster's lede — the count
// and the money, which is the pair anyone opens this tab to see — and the three
// that qualify them sit on the rail underneath.
function TotalsSection({ data, filtered }: { data: DashboardData; filtered: Filtered }) {
  const k = data.kpis;
  return (
    <motion.section className="bill-poster" {...sectionMotion(0)}>
      <SectionHead
        marks={
          filtered.bucketsActive ? (
            <span className="bill-poster-fact">
              filtered · <b>{usd(filtered.filteredVolumeUsdc)}</b> across{" "}
              <b>{plural(filtered.filteredBillCount, "bill")}</b>
            </span>
          ) : null
        }
        note="Everything you have billed and everything still outstanding, in USDC, for the wallets in scope. Claimable is money already paid into your bills and waiting to be pulled out — it is yours, it is just not in your wallet yet."
        step={ANALYTICS_STEPS[0]}
      />

      <div className="bill-poster-body">
        <div className="bill-poster-lede">
          <div className="bill-cell">
            <span className="settle-label">Bills created</span>
            <div className="bill-display">{k.createdCount.toLocaleString()}</div>
            <div className="bill-cell-rule" />
          </div>
          <div className="bill-cell" data-total>
            <span className="settle-label">Total billed</span>
            <div className="bill-figure">
              <span className="bill-currency">$</span>
              {fig(k.createdTotalUsdc)}
            </div>
            <div className="bill-cell-rule" />
          </div>
        </div>

        <div className="bill-poster-rail">
          <PosterFact label="Claimable" note="paid in, not collected" value={usd(k.claimableUsdc)} />
          <PosterFact label="Owed to me" note="still unpaid by others" value={usd(k.owedToMeOutstandingUsdc)} />
          {/* No warn tone on either outstanding figure: owing a share you have
              not settled yet is the normal state of a split bill, and a page that
              warns about the ordinary has nothing left to warn with. */}
          <PosterFact label="I owe" note="your unsettled shares" value={usd(k.iOweOutstandingUsdc)} />
        </div>
      </div>
    </motion.section>
  );
}

// 02. The first of the two things a rule cannot say. Billed and settled are
// overlapping bands rather than a stack: settled is a subset of billed, so
// summing them would double-count every dollar that has actually landed.
function ActivitySection({
  filtered,
  range,
  setRange,
}: {
  filtered: Filtered;
  range: RangeKey;
  setRange: (r: RangeKey) => void;
}) {
  const [showTable, setShowTable] = useState(false);
  const rows = filtered.activity.map((p) => ({
    week: fmtWeek(p.weekStart),
    created: num(p.createdUsdc),
    settled: num(p.settledUsdc),
  }));
  const config: ChartConfig = {
    created: { label: "Created", color: "var(--chart-created)" },
    settled: { label: "Settled to date", color: "var(--chart-settled)" },
  };

  return (
    <motion.section className="bill-poster" {...sectionMotion(1)}>
      <SectionHead
        marks={
          <>
            <span
              className="bill-poster-fact bill-key"
              style={{ "--key-ink": "var(--chart-created)" } as CSSProperties}
            >
              billed
            </span>
            <span
              className="bill-poster-fact bill-key"
              style={{ "--key-ink": "var(--chart-settled)" } as CSSProperties}
            >
              settled
            </span>
            {(["7d", "30d", "90d", "all"] as RangeKey[]).map((r) => (
              <Toggle current={range === r} key={r} label={`Last ${r}`} onClick={() => setRange(r)}>
                {r}
              </Toggle>
            ))}
            <Toggle current={showTable} onClick={() => setShowTable((v) => !v)}>
              as table
            </Toggle>
          </>
        }
        note="Billed against settled-to-date, by weekly bucket. The bands overlap rather than stack — everything settled was billed first, so stacking them would count the same dollar twice."
        step={ANALYTICS_STEPS[1]}
      />

      <div className="bill-poster-body">
        {rows.length ? (
          <Reading
            showTable={showTable}
            table={
              <PosterTable
                head={["Week", "Billed", "Settled to date"]}
                rows={rows.map((r) => [r.week, usd(r.created), usd(r.settled)])}
              />
            }
          >
            <ChartContainer className="bill-chart aspect-auto h-[clamp(200px,26vw,300px)] w-full" config={config}>
              <AreaChart data={rows} margin={{ left: 4, right: 8, top: 8 }}>
                <CartesianGrid strokeDasharray="2 4" vertical={false} />
                <XAxis axisLine={false} dataKey="week" tickLine={false} tickMargin={10} />
                <YAxis axisLine={false} tickFormatter={(v) => usd(v)} tickLine={false} width={52} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Area
                  {...PLOT_MOTION}
                  dataKey="created"
                  fill="var(--color-created)"
                  fillOpacity={0.14}
                  stroke="var(--color-created)"
                  strokeWidth={1.5}
                />
                <Area
                  {...PLOT_MOTION}
                  dataKey="settled"
                  fill="var(--color-settled)"
                  fillOpacity={0.28}
                  stroke="var(--color-settled)"
                  strokeWidth={1.5}
                />
              </AreaChart>
            </ChartContainer>
          </Reading>
        ) : (
          <p className="bill-options-hint">Nothing was billed in this range. Widen it, or read all of it.</p>
        )}
      </div>
    </motion.section>
  );
}

// 03. Four categorical readings under one step, because they are four ways of
// asking the same question and numbering them separately would promise a
// sequence that isn't there.
//
// The identity rows are the tab's filter as well as its first reading, and they
// render from the UNFILTERED data on purpose: a bucket that vanished when you
// filtered it out would be one you could never put back.
function BreakdownsSection({
  buckets,
  clearBuckets,
  data,
  filtered,
  toggleBucket,
}: {
  buckets: Set<IdentityBucket>;
  clearBuckets: () => void;
  data: DashboardData;
  filtered: Filtered;
  toggleBucket: (b: IdentityBucket) => void;
}) {
  const drawn = useDrawn();
  const identityTotal = data.byIdentity.reduce((s, x) => s + num(x.volumeUsdc), 0);

  const identityRows: MeterRow[] = IDENTITY_BUCKETS.map((b) => {
    const row = data.byIdentity.find((s) => s.bucket === b);
    const volume = row ? num(row.volumeUsdc) : 0;
    const active = buckets.size === 0 || buckets.has(b);
    const pct = share(volume, identityTotal);
    return {
      active,
      ariaLabel: `${buckets.has(b) ? "Stop filtering to" : "Filter to"} ${BUCKET_LABEL[b]}`,
      ink: `var(--chart-identity-${b})`,
      key: b,
      label: (
        <span className="bill-key" style={{ "--key-ink": `var(--chart-identity-${b})` } as CSSProperties}>
          {BUCKET_LABEL[b]}
        </span>
      ),
      note: row ? `${plural(row.billCount, "bill")}${pct ? ` · ${pct} of billed` : ""}` : "nothing billed this way",
      onClick: () => toggleBucket(b),
      pressed: buckets.has(b),
      value: volume,
    };
  });

  // Non-overlapping and summing to created, so the one-time / recurring split
  // rides the footnote instead of becoming three more rows.
  const created = data.status.reduce((s, x) => s + x.created, 0);
  const STATES: { label: string; ink?: string; pick: (s: DashboardData["status"][number]) => number }[] = [
    { label: "Fully paid", ink: "var(--chart-settled)", pick: (s) => s.fullyPaid },
    { label: "Partly paid", ink: "var(--chart-created)", pick: (s) => s.partiallyPaid },
    { label: "Unpaid", pick: (s) => Math.max(0, s.created - s.fullyPaid - s.partiallyPaid) },
  ];
  const stateRows: MeterRow[] = STATES.map(({ label, ink, pick }) => {
    const oneTime = data.status.filter((s) => s.scope === "one_time").reduce((s, x) => s + pick(x), 0);
    const recurring = data.status.filter((s) => s.scope !== "one_time").reduce((s, x) => s + pick(x), 0);
    const total = oneTime + recurring;
    const pct = share(total, created);
    return {
      // A bill count is a count, so it is printed as one — a "$" in front of
      // "12 fully paid" would be a lie the layout tells.
      format: (n: number) => n.toLocaleString(),
      ink,
      key: label,
      label,
      note: `${oneTime} one-time · ${recurring} recurring${pct ? ` · ${pct} of all bills` : ""}`,
      value: total,
    };
  });

  const aging = [
    { key: "0–7d", value: num(data.aging.d0_7Usdc), note: "fresh" },
    { key: "8–30d", value: num(data.aging.d8_30Usdc), note: "chased once, usually" },
    { key: "30d+", value: num(data.aging.d30plusUsdc), note: "the least likely to land" },
  ];
  const agingTotal = aging.reduce((s, x) => s + x.value, 0);
  const agingRows: MeterRow[] = aging.map((a, i) => {
    const pct = share(a.value, agingTotal);
    return {
      // Only the oldest bucket is a problem rather than a fact, so it is the one
      // drawn in warn ink.
      ink: i === 2 && a.value > 0 ? "var(--warning-text)" : undefined,
      key: a.key,
      label: a.key,
      note: `${a.note}${pct ? ` · ${pct} of outstanding` : ""}`,
      value: a.value,
    };
  });

  const rankTotal = filtered.topCounterparties.reduce((s, c) => s + num(c.volumeUsdc), 0);
  const rankMax = Math.max(...filtered.topCounterparties.map((c) => num(c.volumeUsdc)), 0);

  return (
    <motion.section className="bill-poster" data-drawn={drawn} {...sectionMotion(2)}>
      <SectionHead
        marks={
          buckets.size > 0 ? (
            <>
              <span className="bill-poster-fact">
                <b>{buckets.size}</b> of <b>{IDENTITY_BUCKETS.length}</b> identities
              </span>
              <Toggle onClick={clearBuckets}>clear filter</Toggle>
            </>
          ) : null
        }
        note="Four readings of the same ledger. Each rule is drawn to its share of the largest row in its own block, and every row states its figure beside its label — the tint is which identity, never how much."
        step={ANALYTICS_STEPS[2]}
      />

      <div className="bill-poster-body">
        <Subhead>How people were reached · tap to filter the tab</Subhead>
        <Meters rows={identityRows} />

        <Subhead>Who you split with most</Subhead>
        {filtered.topCounterparties.length ? (
          <div className="bill-ranks">
            {filtered.topCounterparties.map((c, i) => {
              const volume = num(c.volumeUsdc);
              // No handle behind the address means the address IS the identity —
              // so it stays readable as one, and opens the explorer.
              const anonymous = isAddress(c.label);
              const pct = share(volume, rankTotal);
              return (
                <div className="bill-rank" key={`${c.label}-${i}`}>
                  <div className="bill-payer-line">
                    <span className="bill-payer-target">
                      {anonymous ? (
                        <a
                          className="bill-rank-address"
                          href={`${EXPLORER}/address/${c.label}`}
                          rel="noreferrer"
                          target="_blank"
                          title={c.label}
                        >
                          {shortAddr(c.label)}
                        </a>
                      ) : (
                        c.label
                      )}
                    </span>
                    <span className="bill-payer-share">{usd(volume)}</span>
                  </div>
                  <div
                    className="bill-meter-rule"
                    style={meterStyle(
                      rankMax > 0 ? volume / rankMax : 0,
                      i,
                      `var(--chart-identity-${anonymous ? "wallet" : c.bucket})`,
                    )}
                  />
                  <div className="bill-payer-meta">
                    <span>{anonymous ? BUCKET_LABEL.wallet : BUCKET_LABEL[c.bucket]}</span>
                    <span>{plural(c.billCount, "bill")}</span>
                    {pct ? <span>{pct} of this filter</span> : null}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="bill-options-hint">No counterparties match the current filter.</p>
        )}

        <Subhead>Where bills stand</Subhead>
        <Meters rows={stateRows} />

        <Subhead>How long money has been owed</Subhead>
        <Meters rows={agingRows} />
      </div>
    </motion.section>
  );
}

// 04. How you behave rather than what you hold: the share of billing that has
// actually landed, the score that follows from paying on time, and whether the
// standing tabs are keeping up.
function BehaviourSection({ data }: { data: DashboardData }) {
  const drawn = useDrawn();
  const [showTable, setShowTable] = useState(false);

  const created = data.activity.reduce((s, p) => s + num(p.createdUsdc), 0);
  const settled = data.activity.reduce((s, p) => s + num(p.settledUsdc), 0);
  const rate = created > 0 ? Math.min(1, settled / created) : 0;
  const pct = Math.round(rate * 100);

  const rep = data.reputation;
  const repRows = rep.points.map((p) => ({ at: fmtDay(p.at), score: p.score }));
  const repConfig: ChartConfig = { score: { label: "Score", color: "var(--chart-created)" } };

  const shortfalls = data.recurring.reduce((sum, t) => sum + t.shortfallCount, 0);
  const recurringRows: MeterRow[] = data.recurring.map((t) => ({
    // Cycles run, as a percentage of the run it is contracted for. The meter
    // ceiling is a full run rather than the furthest-along tab, so this reads as
    // progress and not as a league table.
    format: (n: number) => `${n}%`,
    ink: t.shortfallCount > 0 ? "var(--warning-text)" : "var(--chart-settled)",
    key: t.tabAddress,
    label: shortAddr(t.tabAddress),
    note: `${plural(t.settlementCount, "cycle")} of ${t.maxSettlements} · ${usd(t.claimableUsdc)} claimable · ${
      t.shortfallCount > 0 ? plural(t.shortfallCount, "shortfall") : "on track"
    }`,
    value: t.maxSettlements > 0 ? Math.round(Math.min(1, t.settlementCount / t.maxSettlements) * 100) : 0,
  }));

  return (
    <motion.section className="bill-poster" data-drawn={drawn} {...sectionMotion(3)}>
      <SectionHead
        marks={
          <>
            <span className="bill-poster-fact">
              {rep.count > 0 ? (
                <>
                  <b>{rep.avgScore}</b>/100 across <b>{plural(rep.count, "payment")}</b>
                </>
              ) : (
                "no payment history yet"
              )}
            </span>
            {rep.lateCount > 0 ? (
              <span className="bill-poster-fact" data-tone="warn">
                <b>{rep.lateCount}</b> late
              </span>
            ) : null}
            {data.recurring.length ? (
              <span className="bill-poster-fact" data-tone={shortfalls > 0 ? "warn" : undefined}>
                {shortfalls > 0 ? <b>{plural(shortfalls, "shortfall")}</b> : "recurring on track"}
              </span>
            ) : null}
            {repRows.length ? (
              <Toggle current={showTable} onClick={() => setShowTable((v) => !v)}>
                as table
              </Toggle>
            ) : null}
          </>
        }
        note="Of everything you have ever billed, the share that has been paid in — then the score that follows from settling before the due date, and how far each standing tab has run."
        step={ANALYTICS_STEPS[3]}
      />

      <div className="bill-poster-body">
        <Subhead>Settlement rate</Subhead>
        <div className="bill-cell">
          <div className="bill-payer-line">
            <span className="settle-label">Settled of everything billed</span>
            <span className="bill-figure">
              {pct}
              <span className="bill-currency">%</span>
            </span>
          </div>
          {/* The one meter that is a headline rather than a row, so it is the
              only one that carries the role: its figure is a percentage of a
              known whole, which is exactly what a meter announces. */}
          <div
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={pct}
            aria-valuetext={`${pct} percent of everything billed has been settled`}
            className="bill-meter-rule"
            data-scale="lede"
            role="meter"
            style={meterStyle(rate, 0, "var(--chart-settled)")}
          />
          <span className="bill-meter-note">
            {usd(settled)} settled to date of {usd(created)} billed.
          </span>
        </div>

        <Subhead>Reputation over time</Subhead>
        {repRows.length ? (
          <Reading
            showTable={showTable}
            table={<PosterTable head={["Date", "Score"]} rows={repRows.map((r) => [r.at, r.score])} />}
          >
            <ChartContainer className="bill-chart aspect-auto h-[clamp(180px,22vw,260px)] w-full" config={repConfig}>
              <LineChart data={repRows} margin={{ left: 4, right: 8, top: 8 }}>
                <CartesianGrid strokeDasharray="2 4" vertical={false} />
                <XAxis axisLine={false} dataKey="at" tickLine={false} tickMargin={10} />
                <YAxis axisLine={false} domain={[0, 100]} tickLine={false} width={36} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Line
                  {...PLOT_MOTION}
                  dataKey="score"
                  dot={false}
                  stroke="var(--color-score)"
                  strokeWidth={1.75}
                  type="monotone"
                />
              </LineChart>
            </ChartContainer>
          </Reading>
        ) : (
          <p className="bill-options-hint">
            No score history to plot yet — a score is written when a bill you owed settles before its due date.
          </p>
        )}

        <Subhead>Recurring health</Subhead>
        {recurringRows.length ? (
          // Progress, not comparison: the ceiling is a full run, so a tab halfway
          // through its cycles draws half a rule even when it is the furthest on.
          <Meters max={100} rows={recurringRows} />
        ) : (
          <p className="bill-options-hint">
            No recurring tabs yet. A tab is a contract on Arc that collects the same split every cycle.
          </p>
        )}
      </div>
    </motion.section>
  );
}

// ── states ──────────────────────────────────────────────────────────────────

// The three screens with nothing to plot. They keep the masthead — it is the
// tab's own head, and it says what the tab is for whether or not there is data
// behind it — and replace the readings with one section that says why.
function StateShell({
  action,
  eyebrow,
  lede,
  note,
  title,
}: {
  action: { label: string; onClick: () => void };
  eyebrow: string;
  lede: string;
  note: string;
  title: string;
}) {
  return (
    <div className="space-y-5">
      <PosterHero eyebrow={eyebrow} legend={legendOf(ANALYTICS_STEPS)} lede={lede} title={title} />
      <motion.section className="bill-poster" {...sectionMotion(0)}>
        <div className="bill-poster-head">
          <span className="settle-label">Nothing to read</span>
        </div>
        <p className="bill-poster-note">{note}</p>
        <div className="bill-poster-body">
          <button className="settle-action" onClick={action.onClick} type="button">
            {action.label}
          </button>
        </div>
      </motion.section>
    </div>
  );
}

function EmptyState({ onDemo }: { onDemo: () => void }) {
  return (
    <motion.section className="bill-poster" {...sectionMotion(0)}>
      <div className="bill-poster-head">
        <span className="settle-label">Nothing yet</span>
      </div>
      <p className="bill-poster-note">
        Nothing has been billed from the wallets in scope, so there is nothing honest to plot. Billed volume, settlement
        rate, counterparties and reputation all take shape here once money starts moving.
      </p>
      <div className="bill-poster-body">
        <button className="settle-action" onClick={onDemo} type="button">
          view sample data
        </button>
      </div>
    </motion.section>
  );
}

// Shaped like the poster it precedes — masthead measure, then a lede pair, then a
// rail — so the page does not reflow when the data lands.
function DashboardSkeleton() {
  return (
    <div aria-busy="true" className="space-y-5">
      <header className="bill-poster bill-masthead">
        <div className="bill-poster-head">
          <span className="settle-label">Reading the chain</span>
        </div>
        <div className="mt-6 h-[clamp(2.5rem,5vw,5.75rem)] w-[min(30rem,85%)] animate-pulse bg-[var(--pay-poster-rule)]" />
        <div className="mt-5 h-3 w-[min(44rem,95%)] animate-pulse bg-[var(--pay-poster-rule)]" />
        <ol className="bill-contents">
          {Array.from({ length: 4 }).map((_, i) => (
            <li className="bill-cell" key={i}>
              <div className="h-3 w-full animate-pulse bg-[var(--pay-poster-rule)]" />
              <div className="bill-cell-rule" />
            </li>
          ))}
        </ol>
      </header>
      <section className="bill-poster">
        <div className="bill-poster-head">
          <span className="settle-label">{ANALYTICS_STEPS[0].kicker}</span>
        </div>
        {/* The section title's own line, held open at its measure — the tallest
            new thing in a section head, so leaving it out is a reflow. */}
        <div className="bill-section-title">
          <div className="h-[clamp(1.5rem,1.05rem+1.75vw,2.6rem)] w-[min(22rem,80%)] animate-pulse bg-[var(--pay-poster-rule)]" />
        </div>
        <div className="bill-poster-body">
          <div className="bill-poster-lede">
            {[0, 1].map((i) => (
              <div className="bill-cell" key={i}>
                <div className="h-[clamp(2.1rem,4.2vw,5rem)] w-[7ch] animate-pulse bg-[var(--pay-poster-rule)]" />
                <div className="bill-cell-rule" />
              </div>
            ))}
          </div>
          <div className="bill-poster-rail">
            {Array.from({ length: 3 }).map((_, i) => (
              <div className="bill-cell" key={i}>
                <div className="h-8 w-full animate-pulse bg-[var(--pay-poster-rule)]" />
                <div className="bill-cell-rule" />
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

// ── net settlement ──────────────────────────────────────────────────────────

// One net position per counterparty, plus the batched settle action.
//
// Two things this view must never imply, because neither is true on chain:
//   1. That settling moves the NET. It doesn't. Registry escrow binds every debt
//      to its own billId, so your side is paid in full, bill by bill, and their
//      side arrives only when they pay (see lib/treasury.ts). The net figure is
//      exposure — a scoreboard, not a transfer.
//   2. That "Settle net" collects what others owe you. It cannot pull from
//      anyone. It pays what YOU owe and claims USDC already escrowed in bills
//      you created.
// The copy below says both out loud, and the button quotes the exact amounts
// that will move.
//
// What batching does buy is transactions: a Circle SCA wallet lands the whole
// selection in ONE atomic tx, a browser EOA needs one approve plus one settle()
// — two prompts, whatever the leg count.
function TreasurySection({
  treasury,
  isDemo,
  scope,
  bothIdentities,
  onSettleNet,
  onSettled,
}: {
  treasury: TreasuryPlan;
  isDemo: boolean;
  scope: Scope;
  bothIdentities: boolean;
  onSettleNet?: (selection: TreasurySettleSelection) => Promise<string | void>;
  onSettled: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // Opt-OUT rather than opt-in, so a reload (or a newly discovered debt) stays
  // ticked and one click still settles everything. Keyed by counterparty
  // address, which survives a refetch; row identity in the list does not.
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const [collect, setCollect] = useState(true);

  const { claimLegCount } = treasury;
  // Only a position where I owe something has anything for me to pay. A row that
  // is purely "they owe me" gets no control — there is nothing to tick.
  const payable = treasury.positions.filter((p) => num(p.iOweThemUsdc) > 0);
  const chosen = payable.filter((p) => !excluded.has(p.counterparty));
  const payTotal = chosen.reduce((s, p) => s + num(p.iOweThemUsdc), 0);
  const payBillCount = chosen.reduce((s, p) => s + p.payBillIds.length, 0);
  const claimTotal = collect ? num(treasury.claimableUsdc) : 0;
  const claimBillCount = collect ? claimLegCount : 0;

  const hasWork = payBillCount > 0 || claimBillCount > 0;
  // "all" spans both identities and each signs differently (Circle SCA batch vs.
  // browser EOA), so settling needs an explicit choice of which one pays.
  const needsScopeChoice = bothIdentities && scope === "all";
  const canSettle = hasWork && !isDemo && !needsScopeChoice && (scope === "social" || Boolean(onSettleNet));
  // Social = Circle SCA → one atomic executeBatch. Wallet = EOA → approve +
  // settle(), which since registry v2 carries every claim and pay leg, so the
  // count is 2 no matter how many legs (1 when there is nothing to approve).
  const atomic = scope === "social";
  const grossTxCount = 2 * payBillCount + claimBillCount;
  const settledTxCount = atomic ? 1 : payBillCount > 0 ? 2 : 1;
  const net = num(treasury.netUsdc);

  function toggle(counterparty: string) {
    setExcluded((current) => {
      const next = new Set(current);
      if (next.has(counterparty)) next.delete(counterparty);
      else next.add(counterparty);
      return next;
    });
  }

  const actionLabel =
    payBillCount > 0 && claimBillCount > 0
      ? `pay ${usd(payTotal)} · collect ${usd(claimTotal)}`
      : payBillCount > 0
        ? `pay ${usd(payTotal)}`
        : claimBillCount > 0
          ? `collect ${usd(claimTotal)}`
          : "nothing selected";

  async function settle() {
    setBusy(true);
    setNote(null);
    // null = "everything", so an untouched view sends no whitelist at all.
    const selection: TreasurySettleSelection = {
      counterparties: excluded.size === 0 ? null : chosen.map((p) => p.counterparty),
      collect,
    };
    try {
      if (scope === "wallet") {
        // The wallet path reports back here rather than into the bills tab.
        setNote((await onSettleNet!(selection)) || null);
      } else {
        const pin = await fetch("/api/wallet/pin").then((r) => r.json()).catch(() => ({}));
        if (!pin.unlocked) {
          setNote("Unlock your wallet (the wallet button in the bottom-right corner), then tap Settle again.");
          return;
        }
        const res = await fetch("/api/treasury/settle", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(selection),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setNote(
            data.error === "insufficient_funds"
              ? data.neededUsdc
                ? `Not enough USDC: this needs ${usd(data.neededUsdc)} but your wallet has ${usd(data.availableUsdc)} available (collections included). Top up on Arc Testnet.`
                : "Your wallet needs more test USDC."
              : (data.error ?? "Settlement failed."),
          );
          return;
        }
        const paidCount = data.paid?.length ?? 0;
        const claimedCount = data.claimed?.length ?? 0;
        const parts = [
          paidCount ? `paid ${plural(paidCount, "bill")}` : "",
          claimedCount ? `collected ${plural(claimedCount, "bill")}` : "",
        ].filter(Boolean);
        setNote(`Done — ${parts.join(" and ")} in one transaction on Arc.`);
      }
      onSettled();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Settlement failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* 01. Where you stand. The net is the lede figure because it is the one
          people come for — and the one they misread, so it says what it is on
          the rail directly under itself rather than behind a tooltip. */}
      <motion.section className="bill-poster" {...sectionMotion(0)}>
        <SectionHead
          marks={
            <span className="bill-poster-fact">
              <b>{plural(treasury.positions.length, "counterparty", "counterparties")}</b> open
            </span>
          }
          note="Your whole position in four figures. The net is exposure, not a payment — no single transfer of that size ever happens, because each bill escrows its own USDC against its own row on Arc."
          step={TREASURY_STEPS[0]}
        />

        <div className="bill-poster-body">
          <div className="bill-poster-lede">
            <div className="bill-cell">
              <span className="settle-label">Net position</span>
              <div className="bill-display">exposure</div>
              <div className="bill-cell-rule" />
            </div>
            {/* No tone on the cell: the warn rule reaches .bill-figure-sm, and
                this figure is set at .bill-figure — so it would tint the label
                and leave the number, which reads as a styling accident. The sign
                and the label say which way it goes. */}
            <div className="bill-cell" data-total>
              <span className="settle-label">{net < 0 ? "You are behind by" : "You are ahead by"}</span>
              <div className="bill-figure">
                <span className="bill-currency">{net < 0 ? "−$" : "$"}</span>
                {fig(Math.abs(net))}
              </div>
              <div className="bill-cell-rule" />
            </div>
          </div>

          <div className="bill-poster-rail">
            <PosterFact
              label="Owed to me"
              note="others' unpaid shares of bills you created — only they can pay these"
              value={usd(treasury.totalTheyOweMeUsdc)}
            />
            <PosterFact
              label="I owe"
              note="your unpaid shares of bills others created — settling pays these"
              value={usd(treasury.totalIOweThemUsdc)}
            />
            <PosterFact
              label="Claimable now"
              note="already escrowed in your bills, waiting to be pulled out"
              value={usd(treasury.claimableUsdc)}
            />
          </div>
        </div>
      </motion.section>

      {/* 02. The legs. Armed when there is something ticked, so the section's own
          top rule draws itself — the same gesture the agents tab makes when a
          mandate goes live. */}
      <motion.section className="bill-poster" data-armed={payBillCount > 0 ? "true" : "false"} {...sectionMotion(1)}>
        <SectionHead
          marks={
            <>
              {payBillCount > 0 ? (
                <span className="bill-poster-fact">
                  <b>{plural(payBillCount, "leg")}</b> selected
                </span>
              ) : null}
              {payable.length > 1 ? (
                <Toggle
                  disabled={busy || isDemo}
                  onClick={() =>
                    setExcluded(
                      chosen.length === payable.length ? new Set(payable.map((p) => p.counterparty)) : new Set(),
                    )
                  }
                >
                  {chosen.length === payable.length ? "skip all" : "pay all"}
                </Toggle>
              ) : null}
            </>
          }
          note={
            <>
              Settling pays your side; it cannot collect theirs. Marking a counterparty <em>pay</em> settles your unpaid
              shares of their bills in full, one payment per bill, because each bill escrows its own USDC — there is no
              on-chain way to cancel their debt against yours. So if you owe @alice $9 and she owes you $12, settling
              sends $9 today and her $12 lands when she pays. Mark anyone <em>skip</em> and a bill you dispute simply
              stays unpaid.
            </>
          }
          step={TREASURY_STEPS[1]}
        />

        <div className="bill-poster-body">
          {treasury.positions.length === 0 ? (
            <p className="bill-options-hint">Nothing outstanding — every bill on both sides is settled.</p>
          ) : (
            <div className="bill-payers">
              {treasury.positions.map((p) => {
                const rowNet = num(p.netUsdc);
                const owe = num(p.iOweThemUsdc);
                const theyOwe = num(p.theyOweMeUsdc);
                const ticked = owe > 0 && !excluded.has(p.counterparty);
                // No social identity → the address IS the name (see
                // lib/treasury.ts). Render it as a monospace explorer link so
                // "who is this?" is one click away instead of a dead end.
                const anonymous = p.label === p.counterparty;
                const name = anonymous ? shortAddr(p.counterparty) : p.label;
                return (
                  <div className="bill-payer" key={p.counterparty}>
                    <div className="bill-payer-line">
                      <span className="bill-payer-target">
                        {anonymous ? (
                          <a
                            className="bill-rank-address"
                            href={`${EXPLORER}/address/${p.counterparty}`}
                            rel="noreferrer"
                            target="_blank"
                            title={p.counterparty}
                          >
                            {name}
                          </a>
                        ) : (
                          name
                        )}
                      </span>
                      <span className="bill-payer-share">
                        <span className="bill-currency">{rowNet < 0 ? "−$" : "+$"}</span>
                        {fig(Math.abs(rowNet))}
                      </span>
                    </div>
                    <div className="bill-payer-meta">
                      <span>{anonymous ? BUCKET_LABEL.wallet : BUCKET_LABEL[p.bucket]}</span>
                      {theyOwe > 0 ? <span>owes you {usd(theyOwe)}, unpaid</span> : null}
                      {owe > 0 ? (
                        <span>
                          you owe {usd(owe)} across {plural(p.payBillIds.length, "bill")}
                        </span>
                      ) : null}
                      {owe > 0 ? (
                        <span className="bill-payer-remove">
                          <Toggle
                            disabled={busy || isDemo}
                            label={`${ticked ? "Skip" : "Pay"} ${usd(owe)} to ${name}`}
                            onClick={() => toggle(p.counterparty)}
                            pressed={ticked}
                          >
                            {ticked ? "paying" : "skipped"}
                          </Toggle>
                        </span>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {claimLegCount > 0 ? (
            <div className="bill-options">
              <span className="bill-pair">
                <span className="settle-label">also</span>
                <Toggle disabled={busy || isDemo} onClick={() => setCollect((v) => !v)} pressed={collect}>
                  collect {usd(treasury.claimableUsdc)} from {plural(claimLegCount, "bill")} you created
                </Toggle>
              </span>
            </div>
          ) : null}
        </div>
      </motion.section>

      {/* 03. What one click will do, quoted before it does it. */}
      <motion.section className="bill-poster" data-armed={hasWork ? "true" : "false"} {...sectionMotion(2)}>
        <SectionHead
          marks={
            hasWork ? (
              <span className="bill-poster-fact">
                <b>{settledTxCount}</b> transaction{settledTxCount === 1 ? "" : "s"} instead of <b>{grossTxCount}</b>
              </span>
            ) : null
          }
          note="Batching removes transactions, not transfers. Every debt is still paid to its own bill on Arc — you just approve it once."
          step={TREASURY_STEPS[2]}
        />

        <div className="bill-poster-body">
          <div className="bill-poster-rail">
            <PosterFact
              label="This will send"
              note={
                payBillCount > 0
                  ? `to ${plural(chosen.length, "counterparty", "counterparties")} across ${plural(payBillCount, "bill")}`
                  : "nothing marked pay"
              }
              value={usd(payTotal)}
            />
            <PosterFact
              label="And pull out"
              note={claimBillCount > 0 ? `from ${plural(claimBillCount, "bill")} you created` : "collection is off"}
              value={usd(claimTotal)}
            />
            <PosterFact
              label="Wallet prompts"
              note={
                atomic
                  ? "one atomic transaction — every approval, payment and claim lands together, or none of it does"
                  : "one USDC approval, then one transaction carrying every payment and collection"
              }
              value={String(settledTxCount)}
            />
          </div>

          <AnimatePresence>
            {needsScopeChoice ? (
              <motion.p className="bill-options-hint" key="scope" {...revealMotion}>
                You have two wallets and each signs differently — pick one in the masthead above to choose which one
                settles.
              </motion.p>
            ) : null}
          </AnimatePresence>

          <div className="bill-options">
            <button className="settle-action" disabled={!canSettle || busy} onClick={settle} type="button">
              {busy ? "settling on arc…" : actionLabel}
            </button>
          </div>

          <AnimatePresence>
            {note ? (
              <motion.p className="bill-options-hint" key="note" {...revealMotion}>
                {note}
              </motion.p>
            ) : null}
            {isDemo ? (
              <motion.p className="bill-options-hint" key="demo" {...revealMotion}>
                These are sample figures, so settling is disabled.
              </motion.p>
            ) : null}
          </AnimatePresence>
        </div>
      </motion.section>
    </>
  );
}
