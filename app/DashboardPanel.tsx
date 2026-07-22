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
import { BarChart3, FlaskConical, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { IDENTITY_BUCKETS, type DashboardData, type IdentityBucket } from "@/lib/dashboard-types";

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

// socialWallet = the Circle DCW address from social login (X/Discord/email);
// browserWallet = the connected non-custodial wallet. Either may be null. The
// scope selector appears only when both exist.
export default function DashboardPanel({
  socialWallet = null,
  browserWallet = null,
}: {
  socialWallet?: string | null;
  browserWallet?: string | null;
}) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [demo, setDemo] = useState(false);
  const [range, setRange] = useState<RangeKey>("30d");
  const [scope, setScope] = useState<Scope>("all");
  const [buckets, setBuckets] = useState<Set<IdentityBucket>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const hasSocial = Boolean(socialWallet);
  const hasWallet = Boolean(browserWallet);
  const bothIdentities = hasSocial && hasWallet;
  // With one identity, the scope is forced to it; the selector only shows when
  // both exist. "all" unions the two.
  const effectiveScope: Scope = bothIdentities ? scope : hasSocial ? "social" : "wallet";
  const walletsParam = (
    effectiveScope === "social"
      ? [socialWallet]
      : effectiveScope === "wallet"
        ? [browserWallet]
        : [socialWallet, browserWallet]
  )
    .filter(Boolean)
    .join(",");

  // Nothing to report on: signed out AND no wallet connected (derived, no state —
  // the connect card renders from this and the effect skips fetching).
  const noWallet = !demo && !walletsParam;

  useEffect(() => {
    if (!demo && !walletsParam) return;
    let alive = true;
    const qs = demo ? "?demo=1" : `?wallets=${encodeURIComponent(walletsParam)}`;
    fetch(`/api/dashboard${qs}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: DashboardData) => {
        if (alive) {
          setData(d);
          setError(null); // clear a stale error after a scope/wallet change refetch
        }
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [demo, reloadKey, walletsParam]);

  // Reset synchronously from the events that trigger a refetch, not inside the
  // effect (avoids react-hooks/set-state-in-effect) — nulling data re-shows the skeleton.
  function reload() {
    setData(null);
    setError(null);
    setReloadKey((k) => k + 1);
  }
  function toggleDemo() {
    setData(null);
    setError(null);
    setDemo((d) => !d);
  }
  function pickScope(s: Scope) {
    setData(null);
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
      <div className="panel">
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <BarChart3 className="text-[var(--text-muted)]" size={28} />
          <p className="max-w-sm text-sm text-[var(--text-muted)]">
            Sign in or connect a non-custodial wallet to see your analytics.
          </p>
          <button className="secondary-button" onClick={toggleDemo} type="button">
            <FlaskConical size={15} /> View sample data
          </button>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="panel">
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <BarChart3 className="text-[var(--text-muted)]" size={28} />
          <p className="text-sm text-[var(--text-muted)]">
            Couldn&apos;t load your analytics{error.includes("401") ? " — sign in to see your dashboard." : "."}
          </p>
          <button className="secondary-button" onClick={reload} type="button">
            <RefreshCw size={15} /> Try again
          </button>
        </div>
      </div>
    );
  }

  if (!data || !filtered) return <DashboardSkeleton />;

  const showEmpty = !data.isDemo && isAllZero(data);

  return (
    <div className="space-y-4">
      <DashboardHeader
        isDemo={data.isDemo}
        demo={demo}
        onToggleDemo={toggleDemo}
        scope={effectiveScope}
        onScope={bothIdentities ? pickScope : undefined}
      />

      {showEmpty ? (
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

const SCOPE_LABEL: Record<Scope, string> = { all: "All", social: "Social", wallet: "Non-custodial" };

function DashboardHeader({
  isDemo,
  demo,
  onToggleDemo,
  scope,
  onScope,
}: {
  isDemo: boolean;
  demo: boolean;
  onToggleDemo: () => void;
  scope: Scope;
  onScope?: (s: Scope) => void; // undefined → only one identity, no selector
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <span className="text-[var(--accent)]">
          <BarChart3 size={19} />
        </span>
        Analytics
        {isDemo ? (
          <span className="status-dot status-progress inline-flex items-center gap-1">
            <FlaskConical size={12} /> Sample data
          </span>
        ) : null}
      </h2>
      <div className="flex flex-wrap items-center gap-2">
        {onScope && !demo ? (
          <div className="segmented-control text-xs" role="group" aria-label="Wallet identity">
            {(["all", "social", "wallet"] as Scope[]).map((s) => (
              <button
                key={s}
                className={`tab-button ${scope === s ? "tab-button-active" : ""}`}
                onClick={() => onScope(s)}
                type="button"
              >
                {SCOPE_LABEL[s]}
              </button>
            ))}
          </div>
        ) : null}
        <button className="secondary-button" onClick={onToggleDemo} type="button">
          <FlaskConical size={15} /> {demo ? "Exit sample data" : "View sample data"}
        </button>
      </div>
    </div>
  );
}

function Frame({ className = "", children }: { className?: string; children: ReactNode }) {
  return (
    <div className={`rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 ${className}`}>
      {children}
    </div>
  );
}

// A chart section with a title and (when `table` is given) a Chart/Table toggle.
// The table renders the same numbers so identity is never conveyed by color alone.
function ChartCard({
  title,
  subtitle,
  action,
  table,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
  table?: ReactNode;
  children: ReactNode;
}) {
  const [showTable, setShowTable] = useState(false);
  return (
    <Frame>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          {subtitle ? <p className="mt-0.5 text-xs text-[var(--text-muted)]">{subtitle}</p> : null}
        </div>
        <div className="flex items-center gap-2">
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
        </div>
      </div>
      {showTable && table ? table : children}
    </Frame>
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

function KpiRow({ data, filtered }: { data: DashboardData; filtered: Filtered }) {
  const k = data.kpis;
  const tiles: { label: string; value: string }[] = [
    { label: "Bills created", value: String(k.createdCount) },
    { label: "Total billed", value: usd(k.createdTotalUsdc) },
    { label: "Claimable", value: usd(k.claimableUsdc) },
    { label: "Owed to me", value: usd(k.owedToMeOutstandingUsdc) },
    { label: "I owe", value: usd(k.iOweOutstandingUsdc) },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {tiles.map((t) => (
        <Frame key={t.label} className="p-3">
          <div className="amount-text text-xl font-semibold tabular-nums">{t.value}</div>
          <div className="mt-0.5 text-xs text-[var(--text-muted)]">{t.label}</div>
        </Frame>
      ))}
      {filtered.bucketsActive ? (
        <div className="col-span-2 flex items-center text-xs text-[var(--text-muted)] sm:col-span-3 lg:col-span-5">
          Filtered to selected identities: {usd(filtered.filteredVolumeUsdc)} billed across {filtered.filteredBillCount} bill
          {filtered.filteredBillCount === 1 ? "" : "s"}.
        </div>
      ) : null}
    </div>
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
      title="Activity"
      subtitle="Billed vs. settled to date, by weekly bucket (USDC)"
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
    <ChartCard title="By identity" subtitle="Billed volume per identity type — click to filter" table={table}>
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
    <ChartCard title="Status funnel" subtitle="Bill counts by settlement state" table={table}>
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
    <ChartCard title="Top counterparties" subtitle="Ranked by billed volume, colored by identity" table={table}>
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
    <ChartCard title="Aging" subtitle="Outstanding owed-to-me by age of bill (USDC)" table={table}>
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
    <Frame>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Settlement rate</h3>
        <span className="text-sm font-semibold tabular-nums">{Math.round(rate * 100)}%</span>
      </div>
      <div className="h-3 w-full overflow-hidden rounded-full bg-[var(--surface-muted)]">
        <div
          className="h-full rounded-full"
          style={{ width: `${rate * 100}%`, backgroundColor: "var(--chart-settled)" }}
        />
      </div>
      <p className="mt-2 text-xs text-[var(--text-muted)]">
        {usd(settled)} settled to date of {usd(created)} billed.
      </p>
    </Frame>
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
    <ChartCard title="Reputation trend" subtitle="On-chain timeliness score over time" action={badge}>
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
  return (
    <Frame>
      <h3 className="mb-3 text-sm font-semibold">Recurring health</h3>
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
                <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-[var(--surface)]">
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
    </Frame>
  );
}

// ── states ──────────────────────────────────────────────────────────────────

function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-[var(--text-muted)]">{children}</p>;
}

function EmptyState({ onDemo }: { onDemo: () => void }) {
  return (
    <Frame className="p-10">
      <div className="flex flex-col items-center gap-3 text-center">
        <BarChart3 className="text-[var(--text-muted)]" size={30} />
        <h3 className="text-base font-semibold">No analytics yet</h3>
        <p className="max-w-sm text-sm text-[var(--text-muted)]">
          Create your first bill to see your billed volume, settlement rate, counterparties, and reputation take shape here.
        </p>
        <button className="secondary-button mt-1" onClick={onDemo} type="button">
          <FlaskConical size={15} /> View sample data
        </button>
      </div>
    </Frame>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-base font-semibold text-[var(--text-muted)]">
          <Loader2 className="animate-spin" size={18} /> Loading analytics…
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-16 animate-pulse rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-muted)]" />
        ))}
      </div>
      <div className="h-[240px] animate-pulse rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-muted)]" />
      <div className="grid gap-4 lg:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-[220px] animate-pulse rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-muted)]" />
        ))}
      </div>
    </div>
  );
}
