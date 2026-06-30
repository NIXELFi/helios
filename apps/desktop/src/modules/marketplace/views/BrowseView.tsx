// Browse view — every approved add-on the member is allowed to see, scoped by a
// subteam filter + free-text search. Recommended add-ons surface first. Cards are
// presentational: install/open/detail are callbacks owned by MarketplaceModule so
// this view stays pure and trivially testable with stubbed data.

import { useMemo, useState } from "react";
import { IconSearch, IconStarFilled } from "@tabler/icons-react";
import type { AvailablePlugin } from "../data/useMarketplace";
import { PermissionList } from "../components/PermissionList";
import { hasUpdate } from "../lib/version";

const ALL = "__all__";

export function BrowseView({
  plugins,
  loading,
  error,
  onOpenDetail,
  onRequestInstall,
  onOpen,
}: {
  plugins: AvailablePlugin[];
  loading: boolean;
  error: string | null;
  onOpenDetail: (plugin: AvailablePlugin) => void;
  onRequestInstall: (plugin: AvailablePlugin) => void;
  onOpen: (plugin: AvailablePlugin) => void;
}) {
  const [query, setQuery] = useState("");
  const [subteam, setSubteam] = useState<string>(ALL);

  const subteams = useMemo(() => {
    const set = new Set<string>();
    for (const p of plugins) if (p.subteam) set.add(p.subteam);
    return [...set].sort();
  }, [plugins]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return plugins
      .filter((p) => (subteam === ALL ? true : p.subteam === subteam))
      .filter((p) => {
        if (!q) return true;
        return (
          p.name.toLowerCase().includes(q) ||
          (p.subteam ?? "").toLowerCase().includes(q) ||
          (p.manifest.description ?? "").toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        if (a.isRecommended !== b.isRecommended) return a.isRecommended ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  }, [plugins, query, subteam]);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[12rem] flex-1">
          <IconSearch
            size={14}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-helios-dim"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search add-ons…"
            aria-label="Search add-ons"
            className="w-full rounded-sm border border-helios-line bg-helios-panel py-1.5 pl-7 pr-2 text-xs text-helios-text placeholder:text-helios-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
          />
        </div>
        {subteams.length > 0 && (
          <select
            value={subteam}
            onChange={(e) => setSubteam(e.target.value)}
            aria-label="Filter by subteam"
            className="rounded-sm border border-helios-line bg-helios-panel px-2 py-1.5 text-xs text-helios-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
          >
            <option value={ALL}>All subteams</option>
            {subteams.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        )}
      </div>

      {loading && <p className="text-sm text-helios-dim">Loading add-ons…</p>}

      {error && (
        <div className="rounded-sm border border-helios-danger/40 bg-helios-danger/10 p-3 text-xs text-helios-danger">
          Couldn’t load the marketplace: {error}
        </div>
      )}

      {!loading && !error && visible.length === 0 && (
        <p className="text-sm text-helios-dim">
          {plugins.length === 0
            ? "No add-ons are available to you yet."
            : "No add-ons match your search."}
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {visible.map((p) => (
          <BrowseCard
            key={p.id}
            plugin={p}
            onOpenDetail={() => onOpenDetail(p)}
            onRequestInstall={() => onRequestInstall(p)}
            onOpen={() => onOpen(p)}
          />
        ))}
      </div>
    </div>
  );
}

function BrowseCard({
  plugin,
  onOpenDetail,
  onRequestInstall,
  onOpen,
}: {
  plugin: AvailablePlugin;
  onOpenDetail: () => void;
  onRequestInstall: () => void;
  onOpen: () => void;
}) {
  const installed = plugin.installedVersion !== null;
  const updatable = hasUpdate(plugin);

  return (
    <div className="flex flex-col rounded-md border border-helios-line bg-helios-panel p-4">
      <button
        type="button"
        onClick={onOpenDetail}
        className="text-left focus-visible:outline-none"
        aria-label={`Details for ${plugin.name}`}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            {plugin.isRecommended && (
              <IconStarFilled size={12} className="shrink-0 text-asu-gold" aria-label="Recommended" />
            )}
            <span className="font-medium text-helios-text">{plugin.name}</span>
          </div>
          <span className="shrink-0 text-[10px] text-helios-dim">v{plugin.version}</span>
        </div>
        {plugin.subteam && (
          <div className="mt-0.5 text-[10px] uppercase tracking-wider text-helios-dim">
            {plugin.subteam}
          </div>
        )}
        {plugin.manifest.description && (
          <p className="mt-2 line-clamp-2 text-xs text-helios-dim">{plugin.manifest.description}</p>
        )}
      </button>

      <div className="mt-3 flex flex-wrap gap-1.5">
        <PermissionList permissions={plugin.permissions} mode="badge" />
      </div>

      <div className="mt-4 flex items-center gap-2">
        {!installed && (
          <button
            type="button"
            onClick={onRequestInstall}
            className="rounded-sm bg-asu-gold px-3 py-1.5 text-xs font-semibold text-helios-base transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
          >
            Install
          </button>
        )}
        {installed && (
          <>
            <button
              type="button"
              onClick={onOpen}
              className="rounded-sm border border-asu-gold/60 px-3 py-1.5 text-xs font-semibold text-asu-gold transition-colors hover:bg-asu-gold/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
            >
              Open
            </button>
            {updatable && (
              <button
                type="button"
                onClick={onRequestInstall}
                className="rounded-sm bg-asu-gold px-3 py-1.5 text-xs font-semibold text-helios-base transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
              >
                Update to v{plugin.version}
              </button>
            )}
            {!updatable && <span className="text-[10px] text-helios-success">Installed</span>}
          </>
        )}
      </div>
    </div>
  );
}
