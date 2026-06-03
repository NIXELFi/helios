import { useMemo, useState } from "react";
import { useActiveVault } from "../data/useActiveVault";
import { useAllFiles } from "../data/useAllFiles";
import { useFolders } from "../data/useFolders";
import { useLocks } from "../data/useLocks";
import { useVaultUsers } from "../data/useVaultUsers";
import { useIsAdmin } from "../data/useIsAdmin";
import { useSetSpotlight } from "../data/useSetSpotlight";
import { folderPath } from "../data/folder-paths";
import { computeVaultInsights } from "../lib/vaultStats";
import { formatBytes, formatNumber } from "../lib/chart-utils";
import { ChartCard, StatCard, EmptyChart } from "../components/charts/ChartCard";
import { Donut } from "../components/charts/Donut";
import { HBars } from "../components/charts/HBars";
import { Columns } from "../components/charts/Columns";
import { AreaLine } from "../components/charts/AreaLine";
import type { RecentFile } from "../lib/vaultStats";
import { SpotlightCard } from "../components/SpotlightCard";
import { SpotlightPicker } from "../components/SpotlightPicker";
import { holderLabel } from "./WhoHasWhatScreen";
import type { VaultFile } from "../data/types";

export function InsightsScreen() {
  const { activeVaultId: vaultId, activeVault, refetch: refetchVaults } = useActiveVault();
  const { data: files, loading: filesLoading, error: filesError } = useAllFiles(vaultId ?? undefined);
  const { data: folders } = useFolders(vaultId ?? undefined);
  const { data: locks } = useLocks();
  const { data: users } = useVaultUsers(); // admin-gated; errors ignored (fallback below)
  const isAdmin = useIsAdmin();
  const setSpotlight = useSetSpotlight();
  const [picking, setPicking] = useState(false);

  const folderList = useMemo(() => folders ?? [], [folders]);
  const fileList = useMemo(() => files ?? [], [files]);
  const userList = useMemo(() => users ?? [], [users]);

  // Locks scoped to this vault's files (useLocks is cross-vault).
  const vaultLocks = useMemo(() => {
    const ids = new Set(fileList.map((f) => f.id));
    return (locks ?? []).filter((l) => ids.has(l.file_id));
  }, [locks, fileList]);

  const insights = useMemo(
    () => computeVaultInsights(fileList, folderList, vaultLocks, userList),
    [fileList, folderList, vaultLocks, userList],
  );

  const pathOf = useMemo(() => (f: VaultFile) => folderPath(f.folder_id, folderList), [folderList]);

  const spotlightFile = useMemo(
    () => fileList.find((f) => f.id === activeVault?.spotlight_file_id) ?? null,
    [fileList, activeVault],
  );
  const spotlightAuthor = useMemo(() => {
    const id = spotlightFile?.latest?.author_id;
    if (!id) return null;
    const u = userList.find((x) => x.user_id === id);
    return u ? holderLabel(u) : null;
  }, [spotlightFile, userList]);

  async function pickSpotlight(fileId: string | null) {
    if (!vaultId) return;
    const ok = await setSpotlight.run(vaultId, fileId);
    if (ok) {
      refetchVaults();
      setPicking(false);
    }
  }

  const months = insights.addedByMonth.slice(-12);

  return (
    <div className="h-full overflow-auto bg-helios-base">
      <header className="flex items-center justify-between border-b border-helios-line px-5 py-3">
        <div className="text-helios-dim">
          Insights{activeVault ? ` — ${activeVault.name}` : ""}
        </div>
        {!filesLoading && files ? (
          <div className="text-xs text-helios-dim">
            {formatNumber(insights.totalFiles)} files · {formatBytes(insights.totalBytes)}
          </div>
        ) : null}
      </header>

      {filesError ? (
        <div className="m-5 rounded border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm text-red-200">
          Couldn't load vault data: {filesError.message}
        </div>
      ) : filesLoading && !files ? (
        <div className="p-6 text-sm text-helios-dim">Crunching the numbers…</div>
      ) : (
        <div className="flex flex-col gap-4 p-5">
          {/* Spotlight hero */}
          <SpotlightCard
            file={spotlightFile}
            path={spotlightFile ? pathOf(spotlightFile) : ""}
            authorLabel={spotlightAuthor}
            canEdit={isAdmin}
            onChange={() => setPicking(true)}
          />
          {setSpotlight.error ? (
            <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs text-red-200">
              Couldn't update spotlight: {setSpotlight.error.message}
            </div>
          ) : null}

          {/* KPI row */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
            <StatCard label="Files" value={formatNumber(insights.totalFiles)} />
            <StatCard label="Storage" value={formatBytes(insights.totalBytes)} />
            <StatCard label="Folders" value={formatNumber(insights.folderCount)} />
            <StatCard label="Versions" value={formatNumber(insights.totalVersions)} />
            <StatCard label="Checked out" value={formatNumber(insights.activeCheckouts)} />
            <StatCard
              label="Revisioned"
              value={formatNumber(insights.revisionedFiles)}
              hint={`avg ${formatBytes(insights.avgBytes)}/file`}
            />
            <StatCard label="Stale 180d+" value={formatNumber(insights.staleCount)} />
          </div>

          {/* Charts grid */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <ChartCard title="File types" subtitle="By file count">
              <Donut data={insights.byType} centerLabel="files" formatExtra={formatBytes} />
            </ChartCard>

            <ChartCard title="Storage by area" subtitle="Top-level folders, by size">
              <HBars data={insights.storageByArea} formatValue={formatBytes} accent="#4DB6AC" />
            </ChartCard>

            <ChartCard title="Files added over time" subtitle="New files per month (last 12)">
              <Columns data={months} accent="#FFC627" labelEvery={months.length > 8 ? 2 : 1} />
            </ChartCard>

            <ChartCard title="Revisions per file" subtitle="How many versions files carry">
              <Columns data={insights.revisionDist} accent="#4FC3F7" />
            </ChartCard>

            <ChartCard title="Top contributors" subtitle="By latest-version author">
              <HBars data={insights.topContributors} />
            </ChartCard>

            <ChartCard title="Largest files" subtitle="Biggest objects in the vault">
              <HBars data={insights.largestFiles} formatValue={formatBytes} accent="#FF8A65" />
            </ChartCard>

            <ChartCard title="Vault growth" subtitle="Cumulative files over the project's life">
              <AreaLine data={insights.growthFiles} formatValue={formatNumber} />
            </ChartCard>

            <ChartCard title="File-size distribution" subtitle="Files per size band">
              <Columns data={insights.sizeDistribution} accent="#BA68C8" />
            </ChartCard>

            <ChartCard title="Churn leaders" subtitle="Most-revised files">
              <HBars data={insights.mostRevised} formatValue={(v) => `${v} ver`} accent="#F06292" />
            </ChartCard>

            <ChartCard title="Recently updated" subtitle="Latest check-ins">
              <RecentList items={insights.recentlyUpdated} />
            </ChartCard>
          </div>
        </div>
      )}

      {picking ? (
        <SpotlightPicker
          files={fileList}
          pathOf={pathOf}
          currentId={activeVault?.spotlight_file_id ?? null}
          saving={setSpotlight.loading}
          onPick={pickSpotlight}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </div>
  );
}

function RecentList({ items }: { items: RecentFile[] }) {
  if (items.length === 0) return <EmptyChart />;
  return (
    <ul className="flex flex-col gap-1.5 text-xs">
      {items.map((r, i) => (
        <li key={`${r.name}-${i}`} className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-helios-text" title={r.name}>{r.name}</span>
          <span className="shrink-0 tabular-nums text-helios-dim">{formatBytes(r.bytes)}</span>
          <span className="w-20 shrink-0 text-right tabular-nums text-helios-dim/70">
            {r.when ? new Date(r.when).toLocaleDateString() : "—"}
          </span>
        </li>
      ))}
    </ul>
  );
}
