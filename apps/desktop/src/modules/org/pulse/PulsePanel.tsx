import { useMemo, useState } from "react";
import {
  IconClock,
  IconDatabase,
  IconDeviceGamepad2,
  IconRefresh,
  IconSearch,
  IconUsers,
} from "@tabler/icons-react";
import "./pulse.css";
import { usePulse } from "./usePulse";
import {
  AreaChart,
  Bars,
  C,
  Card,
  ColumnChart,
  Empty,
  Kpi,
  Heatmap,
  StackedColumns,
} from "./charts";
import {
  GROWTH_METRICS,
  WORK_SOURCES,
  actionsOf,
  deltaAbs,
  deltaPct,
  filterPeople,
  formatBytes,
  formatCount,
  formatMetric,
  lastDays,
  mean,
  personLabel,
  presenceBucket,
  relativeTime,
  rolling7,
  sortPeople,
  toHeatGrid,
  toPoints,
  workActionsOf,
  type GrowthMetric,
  type Point,
  type RangeDays,
} from "./pulse-lib";
import type { OpsPerson } from "./types";

const shortLabel = (iso: string) => iso.slice(5);

const RANGES: Array<{ days: RangeDays; label: string }> = [
  { days: 30, label: "30d" },
  { days: 90, label: "90d" },
  { days: 365, label: "All" },
];

/** Admin > Pulse: is Helios healthy, who is on it, and how fast is it growing. */
export function PulsePanel() {
  const pulse = usePulse();
  const [range, setRange] = useState<RangeDays>(90);
  const [metric, setMetric] = useState<GrowthMetric>("users_total");
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  // Games (plinko, blackjack, arcade) generate an order of magnitude more
  // events than engineering work, so they are kept out of the work totals,
  // the module chart and the heatmap unless explicitly folded in.
  const [includeGames, setIncludeGames] = useState(false);

  const days = useMemo(() => lastDays(pulse.series, range), [pulse.series, range]);
  const ov = pulse.overview;

  const growth = useMemo(() => toPoints(days, metric), [days, metric]);
  const active = useMemo(() => toPoints(days, "active_users"), [days]);
  const activeAvg = useMemo(() => rolling7(active), [active]);
  const signups = useMemo(() => toPoints(days, "users_new"), [days]);
  const actions = useMemo(
    () =>
      days.map((d) => ({
        label: shortLabel(d.day),
        iso: d.day,
        value: includeGames ? actionsOf(d) : workActionsOf(d),
      })) as Point[],
    [days, includeGames],
  );
  const gamesPlays = useMemo(() => toPoints(days, "games_plays"), [days]);
  const perModule = useMemo(() => {
    const base = [
      { key: "vault", label: "Vault", color: C.gold, points: toPoints(days, "vault_actions") },
      { key: "pm", label: "PM", color: C.info, points: toPoints(days, "pm_actions") },
    ];
    return includeGames ? [...base, { key: "games", label: "Games", color: C.violet, points: gamesPlays }] : base;
  }, [days, includeGames, gamesPlays]);
  const heat = useMemo(
    () =>
      toHeatGrid(pulse.hourly, new Date().getTimezoneOffset(), (src) => includeGames || WORK_SOURCES.has(src)),
    [pulse.hourly, includeGames],
  );
  const people = useMemo(() => filterPeople(sortPeople(pulse.people), query), [pulse.people, query]);
  const visiblePeople = showAll || query ? people : people.slice(0, 25);

  if (pulse.error) {
    return (
      <div className="p-5">
        <div className="border border-helios-danger/40 bg-helios-danger/10 px-3 py-2 text-xs text-helios-text">
          Pulse could not load: {pulse.error}
        </div>
      </div>
    );
  }
  if (pulse.loading || !ov) {
    return (
      <div className="grid gap-3 p-5" aria-busy>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="h-24 animate-pulse border border-helios-line bg-helios-panel" />
          ))}
        </div>
        <div className="h-64 animate-pulse border border-helios-line bg-helios-panel" />
      </div>
    );
  }

  const today = ov.today;
  const weekAvgActive = mean(pulse.series.slice(-8, -1).map((d) => d.active_users));
  const activeDelta = weekAvgActive > 0 ? ((today.active_users - weekAvgActive) / weekAvgActive) * 100 : null;
  const growthPct = deltaPct(growth);
  const growthAbs = deltaAbs(growth);
  const metricLabel = GROWTH_METRICS.find((m) => m.key === metric)!.label;
  const hourLabel = (h: number) => `${((h + 11) % 12) + 1}${h < 12 ? "a" : "p"}`;
  const connPct = ov.db.max_connections > 0 ? (ov.db.connections / ov.db.max_connections) * 100 : 0;
  const filesDelta = deltaAbs(toPoints(days, "files_total"));

  return (
    <div className="flex flex-col gap-3 p-5">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[11px] text-helios-dim">
          <span className="pulse-dot" aria-hidden />
          Live. Updated {relativeTime(pulse.refreshedAt ? new Date(pulse.refreshedAt).toISOString() : null)}; refreshes every minute.
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            role="switch"
            aria-checked={includeGames}
            onClick={() => setIncludeGames((v) => !v)}
            className={
              "inline-flex items-center gap-1 border px-2 py-1 text-[11px] font-medium transition-colors " +
              (includeGames
                ? "border-helios-violet/60 bg-[#B39DDB]/15 text-[#B39DDB]"
                : "border-helios-line text-helios-dim hover:text-helios-text")
            }
            title="Fold games plays into the work totals, module chart and heatmap"
          >
            <IconDeviceGamepad2 size={13} />
            {includeGames ? "Games included" : "Games separate"}
          </button>
          <div className="flex border border-helios-line" role="radiogroup" aria-label="Range">
            {RANGES.map((r) => (
              <button
                key={r.days}
                type="button"
                role="radio"
                aria-checked={range === r.days}
                onClick={() => setRange(r.days)}
                className={
                  "px-2.5 py-1 text-[11px] font-medium transition-colors " +
                  (range === r.days ? "bg-asu-gold/15 text-asu-gold" : "text-helios-dim hover:text-helios-text")
                }
              >
                {r.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={pulse.refresh}
            className="inline-flex items-center gap-1 border border-helios-line px-2 py-1 text-[11px] text-helios-dim hover:text-helios-text"
            title="Refresh now"
          >
            <IconRefresh size={13} /> Refresh
          </button>
        </div>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi
          label="Online now"
          live
          value={formatCount(ov.online_now)}
          hint={`${formatCount(ov.sessions_live)} live sessions`}
          accent={C.success}
          points={active.slice(-14)}
        />
        <Kpi
          label="Active today (UTC)"
          value={formatCount(today.active_users)}
          delta={
            activeDelta == null
              ? null
              : { text: `${activeDelta >= 0 ? "+" : ""}${activeDelta.toFixed(0)}% vs 7d`, tone: activeDelta > 3 ? "up" : activeDelta < -3 ? "down" : "flat" }
          }
          hint={`${formatCount(ov.active_7d)} this week, ${formatCount(ov.active_30d)} this month`}
          accent={C.info}
          points={active}
        />
        <Kpi
          label="Members"
          value={formatCount(today.users_total)}
          delta={{ text: `+${ov.users_new_7d} this week`, tone: ov.users_new_7d > 0 ? "up" : "flat" }}
          hint={`+${ov.users_new_30d} in 30 days`}
          points={toPoints(days, "users_total")}
        />
        <Kpi
          label="Vault files"
          value={formatCount(today.files_total)}
          delta={{
            text: `${filesDelta >= 0 ? "+" : ""}${formatCount(filesDelta)} in ${range === 365 ? "all" : range + "d"}`,
            tone: filesDelta > 0 ? "up" : filesDelta < 0 ? "down" : "flat",
          }}
          hint={`${formatCount(today.versions_total)} versions, ${ov.locks_active} checked out`}
          points={toPoints(days, "files_total")}
        />
        <Kpi
          label="Content"
          value={formatBytes(today.content_bytes)}
          hint={`${formatBytes(ov.storage.bytes)} in storage, ${formatCount(ov.storage.objects)} objects`}
          accent={C.warn}
          points={toPoints(days, "content_bytes")}
        />
        <Kpi
          label={includeGames ? "Actions today (UTC)" : "Work actions today (UTC)"}
          value={formatCount(includeGames ? actionsOf(today) : workActionsOf(today))}
          hint={`${today.vault_actions} vault, ${today.pm_actions} PM${includeGames ? `, ${today.games_plays} games` : ` (+${today.games_plays} games, kept separate)`}`}
          accent={C.warn}
          points={actions}
        />
      </div>

      {/* Growth */}
      <Card
        title="Growth"
        subtitle={
          growthPct == null
            ? `${metricLabel} over the last ${range === 365 ? "year" : range + " days"}`
            : `${metricLabel}: ${growthAbs >= 0 ? "+" : ""}${formatMetric(metric, growthAbs)} (${growthPct >= 0 ? "+" : ""}${growthPct.toFixed(0)}%) over the last ${range === 365 ? "year" : range + " days"}`
        }
        right={
          <div className="flex border border-helios-line" role="radiogroup" aria-label="Growth metric">
            {GROWTH_METRICS.map((m) => (
              <button
                key={m.key}
                type="button"
                role="radio"
                aria-checked={metric === m.key}
                onClick={() => setMetric(m.key)}
                className={
                  "px-2 py-0.5 text-[10px] font-medium transition-colors " +
                  (metric === m.key ? "bg-asu-gold/15 text-asu-gold" : "text-helios-dim hover:text-helios-text")
                }
              >
                {m.label}
              </button>
            ))}
          </div>
        }
      >
        <AreaChart points={growth} format={(v) => formatMetric(metric, v)} height={220} />
      </Card>

      {/* Activity row */}
      <div className="grid gap-3 lg:grid-cols-2">
        <Card title="Daily active members" subtitle="Distinct accounts with Helios open that day. Dashed line is the 7-day mean.">
          <ColumnChart points={active} accent={C.info} overlay={activeAvg} overlayLabel="7-day mean" />
        </Card>
        <Card
          title="Work by module"
          subtitle={includeGames ? "Vault file events, PM task edits and games plays per day." : "Vault check-ins/outs and file events, PM task edits per day. Games are charted on their own below."}
        >
          <StackedColumns series={perModule} />
        </Card>
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <Card
          title="When the team works"
          subtitle={includeGames ? "All activity including games, local time" : "Engineering activity only, local time"}
          className="lg:col-span-2"
          right={<IconClock size={14} className="text-helios-dim" />}
        >
          <Heatmap grid={heat} hourLabel={hourLabel} />
        </Card>
        <div className="flex flex-col gap-3">
          <Card title="Sign-ups" subtitle="New accounts per day">
            {signups.every((p) => p.value === 0) ? <Empty message="No sign-ups in range" /> : <ColumnChart points={signups} accent={C.success} height={110} />}
          </Card>
          <Card
            title="Games"
            subtitle={`${formatCount(ov.games.players_7d)} players this week, ${formatCount(ov.games.bets_24h)} bets and ${formatCount(ov.games.scores_24h)} arcade scores in 24h`}
            right={<IconDeviceGamepad2 size={14} className="text-[#B39DDB]" />}
          >
            <ColumnChart points={gamesPlays} accent={C.violet} height={110} />
          </Card>
        </div>
      </div>

      {/* Vaults + people */}
      <div className="grid gap-3 lg:grid-cols-3">
        <Card title="Vaults" subtitle="Live files per vault; activity is the last 7 days">
          <Bars
            rows={ov.vaults.map((v) => ({ label: v.name, value: v.files, sub: v.locks > 0 ? `${v.locks} out` : undefined }))}
            format={formatCount}
          />
          <table className="mt-3 w-full text-[10px]">
            <thead className="text-helios-dim">
              <tr>
                <th className="text-left font-medium">Vault</th>
                <th className="text-right font-medium">Versions</th>
                <th className="text-right font-medium">Size</th>
                <th className="text-right font-medium">7d actions</th>
              </tr>
            </thead>
            <tbody className="font-mono-num tabular-nums text-helios-text">
              {ov.vaults.map((v) => (
                <tr key={v.name} className="border-t border-helios-line/60">
                  <td className="py-0.5 font-sans">{v.name}</td>
                  <td className="text-right">{formatCount(v.versions)}</td>
                  <td className="text-right">{formatBytes(v.bytes)}</td>
                  <td className="text-right">{formatCount(v.actions_7d)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-2 text-[10px] text-helios-dim">
            {ov.drafts_unpublished} private drafts, {ov.recycle_bin} in recycle bins
          </div>
        </Card>

        <Card
          title="Who's on"
          className="lg:col-span-2"
          subtitle={`${pulse.people.filter((p) => p.online).length} online, ${pulse.people.length} accounts. Activity bars are the last 30 days.`}
          right={
            <label className="flex items-center gap-1 border border-helios-line px-1.5 py-0.5 text-[11px] text-helios-dim focus-within:border-asu-gold/60">
              <IconSearch size={12} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find a person"
                className="w-32 bg-transparent text-helios-text outline-none placeholder:text-helios-dim/60"
              />
            </label>
          }
        >
          <PeopleTable people={visiblePeople} includeGames={includeGames} />
          {!showAll && !query && people.length > visiblePeople.length ? (
            <button type="button" onClick={() => setShowAll(true)} className="mt-2 text-[11px] text-asu-gold hover:underline">
              Show all {people.length}
            </button>
          ) : null}
        </Card>
      </div>

      {/* Infra */}
      <Card title="Supabase health" right={<IconDatabase size={14} className="text-helios-dim" />}>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Gauge label="Database" value={formatBytes(ov.db.bytes)} sub={`cache hit ${ov.db.cache_hit_pct.toFixed(1)}%`} />
          <Gauge
            label="Connections"
            value={`${ov.db.connections} / ${ov.db.max_connections}`}
            sub={`${ov.db.connections_active} active`}
            pct={connPct}
            tone={connPct > 80 ? "danger" : connPct > 60 ? "warn" : "ok"}
          />
          <Gauge
            label="Notifications"
            value={`${ov.notify.sent_24h} sent / 24h`}
            sub={`${ov.notify.queued} queued, ${ov.notify.failed_24h} dead, last ${relativeTime(ov.notify.last_sent)}`}
            tone={ov.notify.failed_24h > 0 ? "warn" : "ok"}
          />
          <Gauge
            label="Games"
            value={`${ov.games.players_7d} players / 7d`}
            sub={`${ov.games.bets_24h} bets, ${ov.games.scores_24h} scores today; ${ov.games.banned} banned`}
          />
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div>
            <div className="mb-1 text-[10px] font-medium uppercase tracking-widest text-helios-dim">Scheduled jobs</div>
            <div className="flex flex-col gap-1">
              {ov.cron.map((j) => {
                const ok = j.last_status === "succeeded";
                const never = j.last_status == null;
                return (
                  <div key={j.name} className="flex items-center gap-2 text-[11px]">
                    <span
                      className={"inline-block size-2 rounded-full " + (never ? "bg-helios-dim/50" : ok ? "bg-helios-success" : "bg-helios-danger")}
                      aria-label={never ? "not run yet" : ok ? "ok" : "failed"}
                    />
                    <span className="w-44 truncate font-mono-num text-helios-text">{j.name}</span>
                    <span className="w-20 truncate text-helios-dim">{j.schedule}</span>
                    <span className="text-helios-dim">
                      {never ? "not run yet" : `${j.last_status} ${relativeTime(j.last_start)}${j.last_ms != null ? ` in ${Math.round(j.last_ms)} ms` : ""}`}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
          <div>
            <div className="mb-1 text-[10px] font-medium uppercase tracking-widest text-helios-dim">Largest tables</div>
            <Bars rows={ov.db.tables.map((t) => ({ label: t.name, value: t.bytes, sub: t.rows != null ? `${formatCount(t.rows)} rows` : undefined }))} format={formatBytes} accent={C.info} />
          </div>
        </div>
      </Card>
    </div>
  );
}

function Gauge({ label, value, sub, pct, tone = "ok" }: { label: string; value: string; sub?: string; pct?: number; tone?: "ok" | "warn" | "danger" }) {
  const color = tone === "danger" ? C.danger : tone === "warn" ? C.warn : C.success;
  return (
    <div className="border border-helios-line bg-helios-base/40 px-3 py-2">
      <div className="text-[9px] font-medium uppercase tracking-widest text-helios-dim">{label}</div>
      <div className="mt-0.5 font-mono-num text-base font-semibold tabular-nums text-helios-text">{value}</div>
      {pct != null ? (
        <div className="mt-1 h-1 w-full bg-helios-line">
          <div className="h-1" style={{ width: `${Math.min(pct, 100)}%`, backgroundColor: color }} />
        </div>
      ) : null}
      {sub ? <div className="mt-0.5 text-[10px] text-helios-dim">{sub}</div> : null}
    </div>
  );
}

const PRESENCE: Record<ReturnType<typeof presenceBucket>, { label: string; cls: string }> = {
  online: { label: "online", cls: "bg-helios-success/15 text-helios-success" },
  today: { label: "today", cls: "bg-helios-info/15 text-helios-info" },
  week: { label: "this week", cls: "bg-helios-panel text-helios-text" },
  month: { label: "this month", cls: "bg-helios-panel text-helios-dim" },
  idle: { label: "idle", cls: "bg-helios-panel text-helios-dim/70" },
  never: { label: "never", cls: "bg-helios-panel text-helios-dim/50" },
};

function PeopleTable({ people, includeGames }: { people: OpsPerson[]; includeGames: boolean }) {
  if (people.length === 0) return <Empty message="Nobody matches" />;
  const of = (p: OpsPerson) => p.vault_actions_30d + p.pm_actions_30d + (includeGames ? p.games_30d : 0);
  const maxAct = Math.max(1, ...people.map(of));
  return (
    <div className="max-h-[420px] overflow-auto">
      <table className="w-full text-[11px]">
        <thead className="sticky top-0 bg-helios-panel text-[10px] text-helios-dim">
          <tr>
            <th className="py-1 text-left font-medium">Person</th>
            <th className="text-left font-medium">Subteam</th>
            <th className="text-left font-medium">Role</th>
            <th className="text-left font-medium">Last active</th>
            <th className="text-left font-medium">30d activity</th>
          </tr>
        </thead>
        <tbody>
          {people.map((p) => {
            const b = presenceBucket(p);
            const total = of(p);
            return (
              <tr key={p.user_id} className="border-t border-helios-line/60">
                <td className="py-1 pr-2">
                  <div className="flex items-center gap-2">
                    <span className={"inline-block size-1.5 rounded-full " + (p.online ? "bg-helios-success" : "bg-helios-line")} aria-hidden />
                    <span className="truncate text-helios-text" title={p.email ?? undefined}>{personLabel(p)}</span>
                  </div>
                </td>
                <td className="pr-2 text-helios-dim">{p.subteam ?? "-"}</td>
                <td className="pr-2 text-helios-dim">{p.role ?? "-"}</td>
                <td className="pr-2">
                  <span className={"inline-block px-1.5 py-0.5 text-[10px] " + PRESENCE[b].cls} title={p.last_active ?? "never"}>
                    {b === "online" ? "online" : relativeTime(p.last_active)}
                  </span>
                </td>
                <td className="w-40">
                  <div className="flex items-center gap-1.5">
                    <div className="flex h-2 w-24 bg-helios-base" title={`${p.vault_actions_30d} vault, ${p.pm_actions_30d} PM, ${p.games_30d} games`}>
                      <div style={{ width: `${(p.vault_actions_30d / maxAct) * 100}%`, backgroundColor: C.gold }} />
                      <div style={{ width: `${(p.pm_actions_30d / maxAct) * 100}%`, backgroundColor: C.info }} />
                      {includeGames ? <div style={{ width: `${(p.games_30d / maxAct) * 100}%`, backgroundColor: C.violet }} /> : null}
                    </div>
                    <span className="font-mono-num text-[10px] tabular-nums text-helios-dim">{total}</span>
                    {!includeGames && p.games_30d > 0 ? (
                      <span className="text-[9px] text-[#B39DDB]/70" title={`${p.games_30d} games plays in 30 days (not counted)`}>+{formatCount(p.games_30d)}g</span>
                    ) : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="mt-2 flex items-center gap-3 text-[10px] text-helios-dim">
        <span className="inline-flex items-center gap-1"><span className="inline-block size-2" style={{ backgroundColor: C.gold }} /> Vault</span>
        <span className="inline-flex items-center gap-1"><span className="inline-block size-2" style={{ backgroundColor: C.info }} /> PM</span>
        {includeGames ? (
          <span className="inline-flex items-center gap-1"><span className="inline-block size-2" style={{ backgroundColor: C.violet }} /> Games</span>
        ) : (
          <span className="text-helios-dim/70">games shown as +Ng, not counted</span>
        )}
        <span className="ml-auto inline-flex items-center gap-1"><IconUsers size={11} /> sorted by last active</span>
      </div>
    </div>
  );
}
