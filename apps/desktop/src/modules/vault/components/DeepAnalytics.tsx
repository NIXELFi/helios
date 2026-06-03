import { ChartCard, EmptyChart } from "./charts/ChartCard";
import { Donut } from "./charts/Donut";
import { HBars } from "./charts/HBars";
import { Columns } from "./charts/Columns";
import { formatNumber } from "../lib/chart-utils";
import type { VaultInsightsExtra } from "../data/useVaultInsightsExtra";

/** "Activity & history" section — the version-history / locks / refs analytics
 *  fed by the pdm.vault_insights_extra RPC. Pure presentation: the screen passes
 *  the aggregated data plus id→label resolvers (authors, file names). */
export function DeepAnalytics({
  extra,
  loading,
  fileName,
  authorName,
  holderName,
}: {
  extra: VaultInsightsExtra | null;
  loading: boolean;
  fileName: (id: string) => string;
  authorName: (id: string | null) => string;
  holderName: (id: string) => string;
}) {
  if (loading && !extra) {
    return <div className="px-1 py-4 text-xs text-helios-dim">Loading activity & history…</div>;
  }
  if (!extra) return null;

  const months = extra.activity_by_month.slice(-12).map((m) => ({ label: m.month, value: m.commits }));
  const contributors = extra.contributors.map((c) => ({
    label: authorName(c.author_id),
    value: c.commits,
  }));
  const provenance = [
    { label: "glassyPDM import", value: extra.provenance.glassy },
    { label: "Created in Helios", value: extra.provenance.native },
  ].filter((s) => s.value > 0);
  const reused = extra.reuse.most_referenced.map((r) => ({
    label: fileName(r.file_id),
    value: r.refs,
  }));
  const card = extra.datacard;
  const cardSlices = card.parts_total > 0
    ? [
        { label: "With data card", value: card.with_card },
        { label: "Missing", value: Math.max(card.parts_total - card.with_card, 0) },
      ].filter((s) => s.value > 0)
    : [];

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-widest text-helios-dim">
        Activity &amp; history
      </h2>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Commit activity" subtitle="Check-ins per month (last 12)">
          <Columns data={months} accent="#4DB6AC" formatValue={(v) => `${v} commits`} labelEvery={months.length > 8 ? 2 : 1} />
        </ChartCard>

        <ChartCard title="Top contributors" subtitle="By total check-ins">
          <HBars data={contributors} formatValue={(v) => `${v}`} />
        </ChartCard>

        <ChartCard title="Source provenance" subtitle="Versions by origin">
          <Donut data={provenance} centerLabel="versions" />
        </ChartCard>

        <ChartCard title="Data-card coverage" subtitle="Parts/assemblies with parsed properties">
          {card.parts_total === 0 ? (
            <EmptyChart message="No part/assembly files" />
          ) : (
            <div className="flex items-center gap-4">
              <Donut data={cardSlices} centerLabel="parts" />
              <div className="text-xs text-helios-dim">
                <span className="font-mono-num text-lg font-semibold text-helios-text">
                  {Math.round((card.with_card / card.parts_total) * 100)}%
                </span>{" "}
                of {card.parts_total} parts carry a data card
              </div>
            </div>
          )}
        </ChartCard>

        <ChartCard
          title="Most reused parts"
          subtitle={`${formatNumber(extra.reuse.total_links)} references · ${formatNumber(extra.reuse.orphans)} orphans`}
        >
          {reused.length === 0 ? (
            <EmptyChart message="No parsed references in this vault yet" />
          ) : (
            <HBars data={reused} formatValue={(v) => `${v}×`} accent="#9575CD" />
          )}
        </ChartCard>

        <ChartCard
          title="Checkout activity"
          subtitle={`${extra.checkouts.active} active · ${extra.checkouts.force_released_total} force-released all-time`}
        >
          {extra.checkouts.longest_active.length === 0 ? (
            <EmptyChart message="Nothing checked out right now" />
          ) : (
            <ul className="flex flex-col gap-1.5 text-xs">
              {extra.checkouts.longest_active.map((l) => (
                <li key={l.file_id} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-helios-text" title={fileName(l.file_id)}>
                    {fileName(l.file_id)}
                  </span>
                  <span className="shrink-0 text-helios-dim">{holderName(l.user_id)}</span>
                  <span className="w-24 shrink-0 text-right tabular-nums text-helios-dim/70">
                    {sinceLabel(l.acquired_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </ChartCard>
      </div>
    </div>
  );
}

/** Compact "held for" label for an active checkout. */
function sinceLabel(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days >= 1) return `${days}d`;
  const hrs = Math.floor((Date.now() - t) / 3_600_000);
  return hrs >= 1 ? `${hrs}h` : "<1h";
}
