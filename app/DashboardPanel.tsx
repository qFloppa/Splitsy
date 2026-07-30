"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts";
import {
  ArrowRightLeft,
  AtSign,
  BarChart3,
  CalendarClock,
  Filter,
  FlaskConical,
  Gauge,
  Info,
  Landmark,
  Loader2,
  RefreshCw,
  RotateCw,
  ShieldCheck,
  Users,
} from "lucide-react";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
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
import { Panel, TabHero } from "./SpecCard";

type RangeKey = "7d" | "30d" | "90d" | "all";
// Which of the user's wallet identities the dashboard reports on. "all" unions
// the social (custodial DCW) and non-custodial (browser) wallets.
type Scope = "all" | "social" | "wallet";

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

// weekStart buckets are epoch-aligned 7-day windows (Thursday-anchored, NOT ISO
// Monday weeks) — format the date plainly, never "week of Monday…".
function fmtWeek(iso: string) {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}
function fmtDay(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function shortAddr(a: string) {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
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
      <Panel
        icon={<BarChart3 size={15} />}
        note="The dashboard reports on wallets, so it needs to know which ones are yours before it can report anything."
        step="Signed out"
        title="Nothing to report yet"
      >
        <div className="spec-empty">
          <BarChart3 size={26} />
          <span>
            <strong>Sign in, or connect a wallet.</strong>
            <br />
            Either identity works, and if you have both, the dashboard can report on them together or one at a time.
          </span>
          <button className="secondary-button mt-1" onClick={toggleDemo} type="button">
            <FlaskConical size={15} /> View sample data
          </button>
        </div>
      </Panel>
    );
  }

  if (error) {
    return (
      <Panel
        icon={<Info size={15} />}
        note="Nothing is wrong with your bills — this is the dashboard failing to read them."
        step="Couldn't load"
        title="The analytics didn't come back"
      >
        <div className="spec-empty">
          <Info size={26} />
          <span>
            {error.includes("401") ? (
              <>
                <strong>Your session has expired.</strong>
                <br />
                Sign in again and the dashboard will reload.
              </>
            ) : (
              <>
                <strong>The request failed.</strong>
                <br />
                This is usually momentary — trying again is the right first move.
              </>
            )}
          </span>
          <button className="secondary-button mt-1" onClick={reload} type="button">
            <RefreshCw size={15} /> Try again
          </button>
        </div>
      </Panel>
    );
  }

  if (!data || !filtered) return <DashboardSkeleton />;

  const showEmpty = !data.isDemo && isAllZero(data);

  return (
    <div className="space-y-5">
      <DashboardHeader
        isDemo={data.isDemo}
        demo={demo}
        onToggleDemo={toggleDemo}
        scope={effectiveScope}
        onScope={bothIdentities ? pickScope : undefined}
        socialProvider={socialProvider}
        socialHandle={socialHandle}
        browserWallet={browserWallet}
        view={view}
        onView={setView}
        treasuryAvailable={Boolean(data.treasury)}
      />

      {view === "treasury" && data.treasury ? (
        <TreasurySection
          treasury={data.treasury}
          isDemo={data.isDemo}
          scope={effectiveScope}
          bothIdentities={bothIdentities}
          onSettleNet={onSettleNet}
          onSettled={reload}
        />
      ) : showEmpty ? (
        <EmptyState onDemo={toggleDemo} />
      ) : (
        <>
          <KpiRow data={data} filtered={filtered} />
          <ActivitySection filtered={filtered} range={range} setRange={setRange} />
          <div className="grid gap-4 lg:grid-cols-2">
            <IdentitySection filtered={filtered} buckets={buckets} toggleBucket={toggleBucket} />
            <StatusSection data={data} />
            <CounterpartiesSection filtered={filtered} buckets={buckets} toggleBucket={toggleBucket} />
            <AgingSection data={data} />
          </div>
          <SettlementRate data={data} />
          <div className="grid gap-4 lg:grid-cols-2">
            <ReputationSection data={data} />
            <RecurringSection data={data} />
          </div>
        </>
      )}
    </div>
  );
}

// ── shared shells ───────────────────────────────────────────────────────────

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
      <span className="inline-flex items-center gap-1.5">
        <ProviderIcon provider={d.provider} size={12} />
        <span className="max-w-[13ch] truncate">
          {d.prefix}
          {d.label}
        </span>
      </span>
    );
  }
  if (scope === "wallet" && browserWallet) return <span className="font-mono">{shortAddr(browserWallet)}</span>;
  return <>{SCOPE_LABEL[scope]}</>;
}

// The dashboard's masthead. The scope picker, the analytics/treasury switch and
// the sample-data toggle all live inside the hero rather than floating above the
// cards — they change what every card below reports, so they belong to the tab,
// not to any one section.
function DashboardHeader({
  isDemo,
  demo,
  onToggleDemo,
  scope,
  onScope,
  socialProvider = null,
  socialHandle = null,
  browserWallet = null,
  view,
  onView,
  treasuryAvailable,
}: {
  isDemo: boolean;
  demo: boolean;
  onToggleDemo: () => void;
  scope: Scope;
  onScope?: (s: Scope) => void; // undefined → only one identity, no selector
  socialProvider?: IdentityProvider | null;
  socialHandle?: string | null;
  browserWallet?: string | null;
  view: "analytics" | "treasury";
  onView: (v: "analytics" | "treasury") => void;
  treasuryAvailable: boolean;
}) {
  const treasury = view === "treasury";
  return (
    <TabHero
      actions={
        <>
          {/* Which view. Only offered when there is a treasury plan to show —
              a toggle to an empty view is a dead end. */}
          {treasuryAvailable ? (
            <div className="segmented-control" role="group" aria-label="Dashboard view">
              {(["analytics", "treasury"] as const).map((v) => (
                <button
                  className={`tab-button ${view === v ? "tab-button-active" : ""} capitalize`}
                  key={v}
                  onClick={() => onView(v)}
                  type="button"
                >
                  {v}
                </button>
              ))}
            </div>
          ) : null}
          {onScope && !demo ? (
            <div className="segmented-control" role="group" aria-label="Wallet identity">
              {(["all", "social", "wallet"] as Scope[]).map((s) => (
                <button
                  className={`tab-button ${scope === s ? "tab-button-active" : ""}`}
                  key={s}
                  onClick={() => onScope(s)}
                  type="button"
                >
                  <ScopeLabel
                    browserWallet={browserWallet}
                    scope={s}
                    socialHandle={socialHandle}
                    socialProvider={socialProvider}
                  />
                </button>
              ))}
            </div>
          ) : null}
          <button className="secondary-button" onClick={onToggleDemo} type="button">
            <FlaskConical size={15} /> {demo ? "Exit sample data" : "View sample data"}
          </button>
          {isDemo ? (
            <span className="spec-chip spec-chip-warn">
              <FlaskConical size={12} /> Sample data
            </span>
          ) : null}
        </>
      }
      eyebrow={treasury ? "Net settlement" : "Your numbers"}
      icon={treasury ? <ArrowRightLeft size={13} /> : <BarChart3 size={13} />}
      legend={
        treasury
          ? [
              { step: "01 · Netting", label: "Who really owes whom", state: "active" },
              { step: "02 · Legs", label: "The transfers left to make" },
              { step: "03 · Saving", label: "Payments the netting removes" },
            ]
          : [
              { step: "01 · Totals", label: "Billed, claimable, outstanding", state: "active" },
              { step: "02 · Activity", label: "Billed vs. settled, weekly" },
              { step: "03 · Breakdowns", label: "Identity, status, counterparties" },
              { step: "04 · Behaviour", label: "Speed, reputation, recurring" },
            ]
      }
      lede={
        treasury
          ? "Debts between the same people cancel out. This view collapses every open bill into the smallest set of transfers that clears the whole web, then shows you how many payments that saves."
          : "Read across both of your wallets or one at a time. Every figure is computed from bills already on Arc — nothing here is projected, and every chart can be read as a table if colour is not enough."
      }
      title={treasury ? "Settle everything at once" : "Where your money went"}
    />
  );
}

// A chart section, built on the same spec card as every other section in the app
// so a chart reads as part of the page rather than an embedded widget. When
// `table` is given it gets a Chart/Table toggle, which renders the same numbers
// so identity is never conveyed by colour alone.
function ChartCard({
  title,
  step,
  icon,
  subtitle,
  action,
  table,
  children,
}: {
  title: string;
  step?: string;
  icon?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  table?: ReactNode;
  children: ReactNode;
}) {
  const [showTable, setShowTable] = useState(false);
  return (
    <Panel
      action={
        <>
          {action}
          {table ? (
            <div className="segmented-control text-xs">
              <button
                className={`tab-button ${!showTable ? "tab-button-active" : ""}`}
                onClick={() => setShowTable(false)}
                type="button"
              >
                Chart
              </button>
              <button
                className={`tab-button ${showTable ? "tab-button-active" : ""}`}
                onClick={() => setShowTable(true)}
                type="button"
              >
                Table
              </button>
            </div>
          ) : null}
        </>
      }
      icon={icon}
      note={subtitle}
      step={step}
      title={title}
    >
      {showTable && table ? table : children}
    </Panel>
  );
}

function DataTable({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-[var(--border)] text-xs text-[var(--text-muted)]">
            {head.map((h, i) => (
              <th key={h} className={`py-1.5 pr-3 font-medium ${i > 0 ? "text-right" : ""}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className="border-b border-[var(--border)]/60 last:border-0">
              {r.map((c, ci) => (
                <td key={ci} className={`py-1.5 pr-3 ${ci > 0 ? "text-right tabular-nums" : ""}`}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Clickable identity legend — doubles as the multiselect filter control. Always
// shows all 5 buckets so a filtered-out bucket can be re-added.
function IdentityChips({
  buckets,
  toggleBucket,
}: {
  buckets: Set<IdentityBucket>;
  toggleBucket: (b: IdentityBucket) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {IDENTITY_BUCKETS.map((b) => {
        const active = buckets.size === 0 || buckets.has(b);
        return (
          <button
            key={b}
            type="button"
            onClick={() => toggleBucket(b)}
            aria-pressed={buckets.has(b)}
            className={`inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] px-2 py-1 text-xs transition-opacity ${
              active ? "" : "opacity-40"
            }`}
          >
            <span
              className="h-2.5 w-2.5 rounded-[2px]"
              style={{ backgroundColor: `var(--chart-identity-${b})` }}
            />
            {BUCKET_LABEL[b]}
          </button>
        );
      })}
    </div>
  );
}

// ── sections ──────────────────────────────────────────────────────────────

// The five headline figures. Deliberately not a chart: each is a single number
// with no comparison to make, which is the one case a stat tile beats a plot.
// The sub-line gives each figure the context it needs to be actionable.
function KpiRow({ data, filtered }: { data: DashboardData; filtered: Filtered }) {
  const k = data.kpis;
  const tiles: { label: string; value: string; sub: string }[] = [
    { label: "Bills created", value: String(k.createdCount), sub: "written by you" },
    { label: "Total billed", value: usd(k.createdTotalUsdc), sub: "across those bills" },
    { label: "Claimable", value: usd(k.claimableUsdc), sub: "paid in, not collected" },
    { label: "Owed to me", value: usd(k.owedToMeOutstandingUsdc), sub: "still unpaid" },
    { label: "I owe", value: usd(k.iOweOutstandingUsdc), sub: "still unsettled" },
  ];
  return (
    <Panel
      chip={
        filtered.bucketsActive ? (
          <span className="spec-chip spec-chip-attn">
            <span className="spec-dot" />
            Filtered
          </span>
        ) : null
      }
      icon={<Landmark size={15} />}
      note={
        filtered.bucketsActive
          ? `Filtered to the selected identities: ${usd(filtered.filteredVolumeUsdc)} billed across ${filtered.filteredBillCount} bill${filtered.filteredBillCount === 1 ? "" : "s"}.`
          : "Everything you have billed and everything outstanding, in USDC, for the wallets in scope."
      }
      step="01 · Totals"
      title="The headline figures"
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {tiles.map((t) => (
          <div className="spec-stat" key={t.label}>
            <div className="spec-stat-value">{t.value}</div>
            <div className="spec-stat-label">{t.label}</div>
            <div className="spec-stat-sub">{t.sub}</div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function ActivitySection({
  filtered,
  range,
  setRange,
}: {
  filtered: Filtered;
  range: RangeKey;
  setRange: (r: RangeKey) => void;
}) {
  const rows = filtered.activity.map((p) => ({
    week: fmtWeek(p.weekStart),
    created: num(p.createdUsdc),
    settled: num(p.settledUsdc),
  }));
  const config: ChartConfig = {
    created: { label: "Created", color: "var(--chart-created)" },
    settled: { label: "Settled to date", color: "var(--chart-settled)" },
  };
  const rangeSelector = (
    <div className="segmented-control text-xs">
      {(["7d", "30d", "90d", "all"] as RangeKey[]).map((r) => (
        <button
          key={r}
          className={`tab-button ${range === r ? "tab-button-active" : ""}`}
          onClick={() => setRange(r)}
          type="button"
        >
          {r === "all" ? "All" : r}
        </button>
      ))}
    </div>
  );
  const table = (
    <DataTable
      head={["Week", "Created", "Settled to date"]}
      rows={rows.map((r) => [r.week, usd(r.created), usd(r.settled)])}
    />
  );
  return (
    <ChartCard
      icon={<BarChart3 size={15} />}
      step="02 · Activity"
      subtitle="Billed vs. settled to date, by weekly bucket (USDC). Settled is a subset of billed, so the bands overlap rather than stack."
      title="Activity over time"
      action={rangeSelector}
      table={table}
    >
      {rows.length ? (
        <ChartContainer config={config} className="aspect-auto h-[240px] w-full">
          <AreaChart data={rows} margin={{ left: 4, right: 8, top: 8 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis dataKey="week" tickLine={false} axisLine={false} tickMargin={8} />
            <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={(v) => usd(v)} />
            <ChartTooltip content={<ChartTooltipContent />} />
            <ChartLegend content={<ChartLegendContent />} />
            {/* Overlapping (not summed): settled is a subset of created, so stacking would double-count. */}
            <Area dataKey="created" stroke="var(--color-created)" fill="var(--color-created)" fillOpacity={0.18} />
            <Area dataKey="settled" stroke="var(--color-settled)" fill="var(--color-settled)" fillOpacity={0.35} />
          </AreaChart>
        </ChartContainer>
      ) : (
        <EmptyNote>No activity in this range yet.</EmptyNote>
      )}
    </ChartCard>
  );
}

function IdentitySection({
  filtered,
  buckets,
  toggleBucket,
}: {
  filtered: Filtered;
  buckets: Set<IdentityBucket>;
  toggleBucket: (b: IdentityBucket) => void;
}) {
  const rows = filtered.byIdentity.map((s) => ({
    bucket: s.bucket,
    label: BUCKET_LABEL[s.bucket],
    value: num(s.volumeUsdc),
    billCount: s.billCount,
  }));
  const config: ChartConfig = Object.fromEntries(
    IDENTITY_BUCKETS.map((b) => [b, { label: BUCKET_LABEL[b], color: `var(--chart-identity-${b})` }]),
  );
  const table = (
    <DataTable
      head={["Identity", "Volume", "Bills"]}
      rows={rows.map((r) => [r.label, usd(r.value), r.billCount])}
    />
  );
  return (
    <ChartCard
      icon={<AtSign size={15} />}
      step="03 · Breakdown"
      subtitle="Billed volume per identity type. Click a bar to filter every figure on this tab."
      table={table}
      title="How people were reached"
    >
      <IdentityChips buckets={buckets} toggleBucket={toggleBucket} />
      {rows.length ? (
        <ChartContainer config={config} className="mt-3 aspect-auto h-[220px] w-full">
          <BarChart data={rows} layout="vertical" margin={{ left: 4, right: 40 }}>
            <CartesianGrid horizontal={false} strokeDasharray="3 3" />
            <XAxis type="number" tickLine={false} axisLine={false} tickFormatter={(v) => usd(v)} />
            <YAxis type="category" dataKey="label" tickLine={false} axisLine={false} width={64} />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Bar
              dataKey="value"
              radius={4}
              cursor="pointer"
              onClick={(entry: { payload?: { bucket?: IdentityBucket } }) => {
                if (entry?.payload?.bucket) toggleBucket(entry.payload.bucket);
              }}
            >
              {rows.map((r) => (
                <Cell key={r.bucket} fill={`var(--chart-identity-${r.bucket})`} />
              ))}
              <LabelList dataKey="value" position="right" formatter={(v) => usd(v as number)} className="fill-foreground text-xs" />
            </Bar>
          </BarChart>
        </ChartContainer>
      ) : (
        <EmptyNote>No identities match the current filter.</EmptyNote>
      )}
    </ChartCard>
  );
}

function StatusSection({ data }: { data: DashboardData }) {
  // Non-overlapping stack that sums to `created`: fully / partial / unpaid.
  const rows = data.status.map((s) => ({
    scope: s.scope === "one_time" ? "One-time" : "Recurring",
    fullyPaid: s.fullyPaid,
    partiallyPaid: s.partiallyPaid,
    unpaid: Math.max(0, s.created - s.fullyPaid - s.partiallyPaid),
    created: s.created,
  }));
  const config: ChartConfig = {
    fullyPaid: { label: "Fully paid", color: "var(--chart-settled)" },
    partiallyPaid: { label: "Partial", color: "var(--chart-created)" },
    unpaid: { label: "Unpaid", color: "var(--text-muted)" },
  };
  const table = (
    <DataTable
      head={["Scope", "Created", "Partial", "Fully paid"]}
      rows={rows.map((r) => [r.scope, r.created, r.partiallyPaid, r.fullyPaid])}
    />
  );
  return (
    <ChartCard
      icon={<Filter size={15} />}
      step="03 · Breakdown"
      subtitle="Bill counts by settlement state, from written to fully collected."
      table={table}
      title="Where bills stand"
    >
      <ChartContainer config={config} className="aspect-auto h-[220px] w-full">
        <BarChart data={rows} margin={{ left: 4, right: 8, top: 8 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis dataKey="scope" tickLine={false} axisLine={false} tickMargin={8} />
          <YAxis tickLine={false} axisLine={false} width={32} allowDecimals={false} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <ChartLegend content={<ChartLegendContent />} />
          <Bar dataKey="fullyPaid" stackId="s" fill="var(--color-fullyPaid)" radius={[0, 0, 0, 0]} />
          <Bar dataKey="partiallyPaid" stackId="s" fill="var(--color-partiallyPaid)" />
          <Bar dataKey="unpaid" stackId="s" fill="var(--color-unpaid)" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ChartContainer>
    </ChartCard>
  );
}

function CounterpartiesSection({
  filtered,
  buckets,
  toggleBucket,
}: {
  filtered: Filtered;
  buckets: Set<IdentityBucket>;
  toggleBucket: (b: IdentityBucket) => void;
}) {
  const rows = filtered.topCounterparties.map((c) => ({
    bucket: c.bucket,
    label: c.label,
    value: num(c.volumeUsdc),
    billCount: c.billCount,
  }));
  const config: ChartConfig = Object.fromEntries(
    IDENTITY_BUCKETS.map((b) => [b, { label: BUCKET_LABEL[b], color: `var(--chart-identity-${b})` }]),
  );
  const table = (
    <DataTable
      head={["Counterparty", "Type", "Volume", "Bills"]}
      rows={rows.map((r) => [r.label, BUCKET_LABEL[r.bucket], usd(r.value), r.billCount])}
    />
  );
  return (
    <ChartCard
      icon={<Users size={15} />}
      step="03 · Breakdown"
      subtitle="Ranked by billed volume, coloured by how each person was reached."
      table={table}
      title="Who you split with most"
    >
      <IdentityChips buckets={buckets} toggleBucket={toggleBucket} />
      {rows.length ? (
        <ChartContainer config={config} className="mt-3 aspect-auto h-[240px] w-full">
          <BarChart data={rows} layout="vertical" margin={{ left: 4, right: 44 }}>
            <CartesianGrid horizontal={false} strokeDasharray="3 3" />
            <XAxis type="number" tickLine={false} axisLine={false} tickFormatter={(v) => usd(v)} />
            <YAxis type="category" dataKey="label" tickLine={false} axisLine={false} width={110} tickFormatter={(v) => shortAddr(String(v))} />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Bar dataKey="value" radius={4}>
              {rows.map((r, i) => (
                <Cell key={i} fill={`var(--chart-identity-${r.bucket})`} />
              ))}
              <LabelList dataKey="value" position="right" formatter={(v) => usd(v as number)} className="fill-foreground text-xs" />
            </Bar>
          </BarChart>
        </ChartContainer>
      ) : (
        <EmptyNote>No counterparties match the current filter.</EmptyNote>
      )}
    </ChartCard>
  );
}

function AgingSection({ data }: { data: DashboardData }) {
  const rows = [
    { bucket: "0–7d", value: num(data.aging.d0_7Usdc) },
    { bucket: "8–30d", value: num(data.aging.d8_30Usdc) },
    { bucket: "30d+", value: num(data.aging.d30plusUsdc) },
  ];
  const config: ChartConfig = { value: { label: "Outstanding", color: "var(--chart-created)" } };
  const table = (
    <DataTable head={["Age", "Outstanding"]} rows={rows.map((r) => [r.bucket, usd(r.value)])} />
  );
  return (
    <ChartCard
      icon={<CalendarClock size={15} />}
      step="03 · Breakdown"
      subtitle="Outstanding owed-to-me by how long the bill has been open (USDC). The older the bucket, the less likely it lands."
      table={table}
      title="How long money has been owed"
    >
      <ChartContainer config={config} className="aspect-auto h-[220px] w-full">
        <BarChart data={rows} margin={{ left: 4, right: 8, top: 16 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis dataKey="bucket" tickLine={false} axisLine={false} tickMargin={8} />
          <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={(v) => usd(v)} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Bar dataKey="value" fill="var(--color-value)" radius={[4, 4, 0, 0]}>
            <LabelList dataKey="value" position="top" formatter={(v) => usd(v as number)} className="fill-foreground text-xs" />
          </Bar>
        </BarChart>
      </ChartContainer>
    </ChartCard>
  );
}

function SettlementRate({ data }: { data: DashboardData }) {
  const created = data.activity.reduce((s, p) => s + num(p.createdUsdc), 0);
  const settled = data.activity.reduce((s, p) => s + num(p.settledUsdc), 0);
  const rate = created > 0 ? Math.min(1, settled / created) : 0;
  return (
    <Panel
      chip={<span className="spec-chip">{Math.round(rate * 100)}% settled</span>}
      icon={<Gauge size={15} />}
      note="Of everything you have ever billed, the share that has actually been paid in. One meter, because there is only one number to read."
      step="04 · Behaviour"
      title="Settlement rate"
    >
      {/* A meter, not a chart: role + value so it is announced as a percentage
          rather than as a decorative bar. */}
      <div
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={Math.round(rate * 100)}
        aria-valuetext={`${Math.round(rate * 100)} percent settled`}
        className="h-3 w-full overflow-hidden rounded-full bg-[var(--surface-muted)]"
        role="meter"
      >
        <div
          className="h-full rounded-full transition-[width] duration-500 ease-out"
          style={{ width: `${rate * 100}%`, backgroundColor: "var(--chart-settled)" }}
        />
      </div>
      <p className="spec-hint">
        <span className="mono font-semibold">{usd(settled)}</span> settled to date of{" "}
        <span className="mono font-semibold">{usd(created)}</span> billed.
      </p>
    </Panel>
  );
}

function ReputationSection({ data }: { data: DashboardData }) {
  const rep = data.reputation;
  const rows = rep.points.map((p) => ({ at: fmtDay(p.at), score: p.score }));
  const config: ChartConfig = { score: { label: "Score", color: "var(--chart-created)" } };
  const badge = (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium">
      <ShieldCheck size={13} className={rep.lateCount === 0 ? "text-emerald-500" : "text-amber-500"} />
      {rep.count > 0 ? `${rep.avgScore}/100 avg · ${rep.count} paid` : "No payment history yet"}
      {rep.lateCount > 0 ? <span className="text-amber-600">· {rep.lateCount} late</span> : null}
    </span>
  );
  return (
    <ChartCard
      action={badge}
      icon={<ShieldCheck size={15} />}
      step="04 · Behaviour"
      subtitle="Your on-chain timeliness score over time — earned by settling before the due date."
      title="Reputation trend"
    >
      {rows.length ? (
        <ChartContainer config={config} className="aspect-auto h-[220px] w-full">
          <LineChart data={rows} margin={{ left: 4, right: 8, top: 8 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis dataKey="at" tickLine={false} axisLine={false} tickMargin={8} />
            <YAxis tickLine={false} axisLine={false} width={32} domain={[0, 100]} />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Line dataKey="score" type="monotone" stroke="var(--color-score)" strokeWidth={2} dot={false} />
          </LineChart>
        </ChartContainer>
      ) : (
        <EmptyNote>No score history to plot yet — the average badge above reflects your record.</EmptyNote>
      )}
    </ChartCard>
  );
}

function RecurringSection({ data }: { data: DashboardData }) {
  const shortfalls = data.recurring.reduce((sum, t) => sum + t.shortfallCount, 0);
  return (
    <Panel
      chip={
        shortfalls > 0 ? (
          <span className="spec-chip spec-chip-warn">
            <span className="spec-dot" />
            {shortfalls} shortfall{shortfalls === 1 ? "" : "s"}
          </span>
        ) : data.recurring.length > 0 ? (
          <span className="spec-chip spec-chip-live">
            <span className="spec-dot" />
            On track
          </span>
        ) : null
      }
      icon={<RotateCw size={15} />}
      note="How far each recurring tab has run, and whether any cycle has come up short — a shortfall means a member's approval or balance did not cover their share."
      step="04 · Behaviour"
      title="Recurring health"
    >
      {data.recurring.length ? (
        <div className="space-y-3">
          {data.recurring.map((t) => {
            const pct = t.maxSettlements > 0 ? Math.min(1, t.settlementCount / t.maxSettlements) : 0;
            return (
              <div key={t.tabAddress} className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-muted)] p-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-mono text-xs text-[var(--text-muted)]">{shortAddr(t.tabAddress)}</span>
                  <span className="tabular-nums">
                    {t.settlementCount}/{t.maxSettlements} cycles
                  </span>
                </div>
                <div
                  aria-valuemax={t.maxSettlements}
                  aria-valuemin={0}
                  aria-valuenow={t.settlementCount}
                  aria-valuetext={`${t.settlementCount} of ${t.maxSettlements} cycles run`}
                  className="mt-2 h-2 w-full overflow-hidden rounded-full bg-[var(--surface)]"
                  role="meter"
                >
                  <div className="h-full rounded-full" style={{ width: `${pct * 100}%`, backgroundColor: "var(--chart-settled)" }} />
                </div>
                <div className="mt-2 flex items-center justify-between text-xs text-[var(--text-muted)]">
                  <span>Claimable {usd(t.claimableUsdc)}</span>
                  {t.shortfallCount > 0 ? (
                    <span className="status-dot status-warn">{t.shortfallCount} shortfall{t.shortfallCount === 1 ? "" : "s"}</span>
                  ) : (
                    <span className="status-dot status-ok">On track</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <EmptyNote>No recurring tabs yet.</EmptyNote>
      )}
    </Panel>
  );
}

// ── states ──────────────────────────────────────────────────────────────────

function EmptyNote({ children }: { children: ReactNode }) {
  return <div className="spec-empty">{children}</div>;
}

function EmptyState({ onDemo }: { onDemo: () => void }) {
  return (
    <Panel
      icon={<BarChart3 size={15} />}
      note="Nothing has been billed from the wallets in scope yet, so there is nothing honest to plot."
      step="Nothing yet"
      title="No analytics yet"
    >
      <div className="spec-empty">
        <BarChart3 size={26} />
        <span>
          <strong>Create your first bill.</strong>
          <br />
          Billed volume, settlement rate, counterparties and reputation all take shape here once money starts moving.
        </span>
        <button className="secondary-button mt-1" onClick={onDemo} type="button">
          <FlaskConical size={15} /> View sample data
        </button>
      </div>
    </Panel>
  );
}

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
  // is purely "they owe me" gets no checkbox — there is nothing to tick.
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
      ? `Pay ${usd(payTotal)} · collect ${usd(claimTotal)}`
      : payBillCount > 0
        ? `Pay ${usd(payTotal)}`
        : claimBillCount > 0
          ? `Collect ${usd(claimTotal)}`
          : "Nothing selected";

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
          paidCount ? `paid ${paidCount} bill${paidCount === 1 ? "" : "s"}` : "",
          claimedCount ? `collected ${claimedCount} bill${claimedCount === 1 ? "" : "s"}` : "",
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
    <div className="space-y-5">
      <Panel
        icon={<ArrowRightLeft size={15} />}
        note="Your whole position in four figures. The net is exposure, not a payment — no single transfer of that size ever happens, because each bill escrows its own USDC."
        step="01 · Netting"
        title="Where you stand overall"
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <TreasuryTile label="Owed to me" value={usd(treasury.totalTheyOweMeUsdc)} hint="Others' unpaid shares of bills you created. Only they can pay these." />
          <TreasuryTile label="I owe" value={usd(treasury.totalIOweThemUsdc)} hint="Your unpaid shares of bills others created. Settling pays these." />
          <TreasuryTile label="Net position" value={usd(treasury.netUsdc)} emphasis hint="Owed to me minus I owe. A scoreboard of your exposure — no single payment of this size ever happens." />
          <TreasuryTile label="Claimable now" value={usd(treasury.claimableUsdc)} hint="USDC already escrowed in your bills, waiting for you to pull it out." />
        </div>
      </Panel>

      <Panel
        action={
          payable.length > 1 ? (
            <button
              type="button"
              className="secondary-button"
              disabled={busy || isDemo}
              onClick={() => setExcluded(chosen.length === payable.length ? new Set(payable.map((p) => p.counterparty)) : new Set())}
            >
              {chosen.length === payable.length ? "Untick all" : "Tick all"}
            </button>
          ) : null
        }
        chip={
          payBillCount > 0 ? (
            <span className="spec-chip spec-chip-attn">
              <span className="spec-dot" />
              {payBillCount} leg{payBillCount === 1 ? "" : "s"} selected
            </span>
          ) : null
        }
        icon={<Landmark size={15} />}
        live={payBillCount > 0}
        note={
          <>
            Ticking a counterparty pays <em>your</em> unpaid shares of their bills, in full, one payment per bill. What
            they owe you is never collected here — only they can pay that. Untick anyone you would rather not pay.
          </>
        }
        step="02 · Legs"
        title={
          <span className="inline-flex items-center gap-2">
            Net position by counterparty
            <InfoTip label="How settling works">
              <span className="block font-semibold text-[var(--text)]">
                Settling pays your side. It can&rsquo;t collect theirs.
              </span>
              <span className="mt-1.5 block">
                Ticking a counterparty pays <em>your</em> unpaid shares of their bills — in full, one payment per bill,
                because each bill escrows its own USDC on Arc. There is no on-chain way to cancel their debt against
                yours.
              </span>
              <span className="mt-1.5 block">
                What they owe you is not collected here: only they can pay it. You do get{" "}
                <strong className="text-[var(--text)]">Claimable now</strong> — USDC they have already paid into your
                bills.
              </span>
              <span className="mt-1.5 block">
                So if you owe @alice $9 and she owes you $12, settling sends $9 today; her $12 lands when she pays. The
                net &minus;$3 is a scoreboard, never a transfer.
              </span>
              <span className="mt-1.5 block">
                Untick anyone you don&rsquo;t want to pay — a bogus bill stays unpaid and the rest still go through.
              </span>
            </InfoTip>
          </span>
        }
      >
        {treasury.positions.length === 0 ? (
          <div className="spec-empty">
            <ShieldCheck size={26} />
            <span>
              <strong>Nothing outstanding.</strong>
              <br />
              Every bill on both sides is settled.
            </span>
          </div>
        ) : (
          <ul className="space-y-2">
            {treasury.positions.map((p) => {
              const net = num(p.netUsdc);
              const owe = num(p.iOweThemUsdc);
              const theyOwe = num(p.theyOweMeUsdc);
              const ticked = owe > 0 && !excluded.has(p.counterparty);
              // No social identity → the address IS the name (see lib/treasury.ts).
              // Render it as a monospace explorer link with the full value on
              // hover, so "who is this?" is one click away instead of a dead end.
              const anonymous = p.label === p.counterparty;
              const name = anonymous ? shortAddr(p.counterparty) : p.label;
              return (
                <li
                  key={p.counterparty}
                  className={`flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius)] border p-3 text-sm ${
                    owe > 0 && !ticked
                      ? "border-dashed border-[var(--border)] bg-transparent opacity-60"
                      : "border-[var(--border)] bg-[var(--surface-muted)]"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    {owe > 0 ? (
                      <input
                        type="checkbox"
                        checked={ticked}
                        onChange={() => toggle(p.counterparty)}
                        disabled={busy || isDemo}
                        aria-label={`Pay ${usd(p.iOweThemUsdc)} to ${name}`}
                        className="size-4 accent-[var(--accent)]"
                      />
                    ) : (
                      <span className="size-4" aria-hidden />
                    )}
                    {anonymous ? (
                      <a
                        href={`https://testnet.arcscan.app/address/${p.counterparty}`}
                        target="_blank"
                        rel="noreferrer"
                        title={p.counterparty}
                        className="font-mono text-xs font-semibold underline decoration-dotted underline-offset-2"
                      >
                        {name}
                      </a>
                    ) : (
                      <strong>{name}</strong>
                    )}
                    {/* A non-custodial counterparty is not missing anything —
                        the address IS the identity. Tag it for what it is. */}
                    <span className="text-xs text-[var(--text-muted)]">
                      {anonymous ? BUCKET_LABEL.wallet : BUCKET_LABEL[p.bucket]}
                    </span>
                  </span>
                  <span className="flex items-center gap-3 text-xs text-[var(--text-muted)]">
                    {theyOwe > 0 ? <span>owes you {usd(p.theyOweMeUsdc)} (unpaid)</span> : null}
                    {theyOwe > 0 && owe > 0 ? <ArrowRightLeft size={13} /> : null}
                    {owe > 0 ? (
                      <span>
                        you pay {usd(p.iOweThemUsdc)} · {p.payBillIds.length} bill{p.payBillIds.length === 1 ? "" : "s"}
                      </span>
                    ) : null}
                    <strong className={`amount-text text-sm ${net < 0 ? "text-[var(--warning-text)]" : "text-[var(--text)]"}`}>
                      net {net >= 0 ? "+" : "−"}
                      {usd(Math.abs(net))}
                    </strong>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {claimLegCount > 0 ? (
          <label className="flex items-center gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-sm">
            <input
              type="checkbox"
              checked={collect}
              onChange={() => setCollect((v) => !v)}
              disabled={busy || isDemo}
              className="size-4 accent-[var(--accent)]"
            />
            <span>
              Collect <strong className="amount-text">{usd(treasury.claimableUsdc)}</strong> already paid into{" "}
              {claimLegCount} bill{claimLegCount === 1 ? "" : "s"} you created
            </span>
          </label>
        ) : null}
      </Panel>

      <Panel
        chip={
          hasWork ? (
            <span className="spec-chip spec-chip-live">
              <span className="spec-dot" />
              {settledTxCount} instead of {grossTxCount}
            </span>
          ) : null
        }
        icon={<ArrowRightLeft size={15} />}
        live={hasWork}
        note="Batching removes transactions, not transfers. Every debt is still paid to its own bill on Arc — you just approve it once."
        step="03 · Settle"
        title="What one click will do"
      >
        <p className="text-sm">
          {hasWork ? (
            <>
              This will send <strong className="amount-text">{usd(payTotal)}</strong>
              {payBillCount > 0 ? (
                <>
                  {" "}
                  to {chosen.length} counterpart{chosen.length === 1 ? "y" : "ies"} across {payBillCount} bill
                  {payBillCount === 1 ? "" : "s"}
                </>
              ) : null}
              {claimBillCount > 0 ? (
                <>
                  {" "}
                  and pull <strong className="amount-text">{usd(claimTotal)}</strong> out of {claimBillCount} bill
                  {claimBillCount === 1 ? "" : "s"} you created
                </>
              ) : null}
              .
            </>
          ) : (
            <>Nothing selected — tick a counterparty to pay, or the collect box above.</>
          )}
        </p>
        {hasWork ? (
          <p className="text-sm">
            {atomic ? (
              <>
                One atomic transaction instead of <strong className="amount-text">{grossTxCount}</strong> — every
                approval, payment and claim lands together, or none of it does.
              </>
            ) : (
              <>
                <strong className="amount-text">{settledTxCount}</strong> wallet prompt
                {settledTxCount === 1 ? "" : "s"} instead of{" "}
                <strong className="amount-text">{grossTxCount}</strong> — one USDC approval, then one transaction
                carrying every payment and collection.
              </>
            )}
          </p>
        ) : null}
        {needsScopeChoice ? (
          <p className="spec-hint">Pick one of your two wallets above to choose which one settles.</p>
        ) : null}
        <div className="mt-4">
          <button type="button" className="primary-button" disabled={!canSettle || busy} onClick={settle}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <ArrowRightLeft size={15} />}
            {busy ? "Settling on Arc…" : actionLabel}
          </button>
        </div>
        {note ? <p className="spec-hint">{note}</p> : null}
        {isDemo ? <p className="spec-hint">Sample data — settling is disabled.</p> : null}
      </Panel>
    </div>
  );
}

// Click-or-hover explainer, same primitive as X402Info in HomeClient.
//
// It MUST be the portaled Radix tooltip, not an absolutely-positioned child:
// .spec-card sets overflow: hidden (globals.css) to clip its header band to the
// card radius, so any popover rendered as a descendant gets cut off at the card
// edge. Portalling to the body sidesteps the whole question.
//
// `open` is controlled so a tap opens it too — Radix tooltips are hover/focus
// only, and the copy in here is load-bearing enough that it can't be
// desktop-only. Pointer-down outside still dismisses.
function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <TooltipProvider>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger
          type="button"
          aria-label={label}
          onClick={() => setOpen((v) => !v)}
          className="inline-flex text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          <Info size={14} />
        </TooltipTrigger>
        <TooltipContent
          side="bottom"
          align="start"
          collisionPadding={12}
          className="max-w-72 text-left text-xs font-normal leading-relaxed text-[var(--text-muted)] sm:max-w-80"
        >
          {children}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function TreasuryTile({
  label,
  value,
  emphasis,
  hint,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
  hint?: string;
}) {
  return (
    <div className="spec-stat">
      <div className="spec-stat-value">{value}</div>
      <div className="spec-stat-label">
        <span className="inline-flex items-center gap-1">
          {label}
          {hint ? <InfoTip label={`What ${label} means`}>{hint}</InfoTip> : null}
        </span>
      </div>
      {/* The net figure is the one people misread, so it says what it is right
          under the number rather than only behind the info tip. */}
      {emphasis ? <div className="spec-stat-sub">exposure, not a transfer</div> : null}
    </div>
  );
}

// Shaped like the real dashboard — hero, then a 5-tile row, then the charts — so
// the page does not reflow when the data lands.
function DashboardSkeleton() {
  return (
    <div aria-busy="true" className="space-y-5">
      <div className="tab-hero">
        <div className="flex items-center gap-2">
          <Loader2 className="animate-spin text-[var(--accent)]" size={15} />
          <span className="tab-eyebrow">Loading your numbers</span>
        </div>
        <div className="mt-4 h-9 w-[min(26rem,80%)] animate-pulse rounded-[var(--radius)] bg-[var(--surface-muted)]" />
        <div className="mt-3 h-4 w-[min(38rem,95%)] animate-pulse rounded-full bg-[var(--surface-muted)]" />
      </div>
      <div className="spec-card">
        <div className="spec-body grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-20 animate-pulse rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-muted)]" />
          ))}
        </div>
      </div>
      <div className="h-[240px] animate-pulse rounded-[calc(var(--radius)+2px)] border border-[var(--border)] bg-[var(--surface-muted)]" />
      <div className="grid gap-4 lg:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-[220px] animate-pulse rounded-[calc(var(--radius)+2px)] border border-[var(--border)] bg-[var(--surface-muted)]" />
        ))}
      </div>
    </div>
  );
}
