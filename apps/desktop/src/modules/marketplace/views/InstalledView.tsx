// Installed view — the add-ons this member has installed, with launch / update /
// uninstall. "Update" routes back through the same install-consent flow (a new
// version may request new permissions), so the container hands it the same
// callback as a fresh install. Presentational: all actions are callbacks.

import { IconPlayerPlay, IconTrash, IconArrowUp, IconStarFilled } from "@tabler/icons-react";
import type { AvailablePlugin } from "../data/useMarketplace";
import { PermissionList } from "../components/PermissionList";
import { hasUpdate } from "../lib/version";

export function InstalledView({
  plugins,
  loading,
  error,
  busyId,
  onOpen,
  onUpdate,
  onUninstall,
  onOpenDetail,
}: {
  plugins: AvailablePlugin[];
  loading: boolean;
  error: string | null;
  busyId: string | null;
  onOpen: (plugin: AvailablePlugin) => void;
  onUpdate: (plugin: AvailablePlugin) => void;
  onUninstall: (plugin: AvailablePlugin) => void;
  onOpenDetail: (plugin: AvailablePlugin) => void;
}) {
  if (loading) return <p className="text-sm text-helios-dim">Loading…</p>;
  if (error)
    return (
      <div className="rounded-sm border border-helios-danger/40 bg-helios-danger/10 p-3 text-xs text-helios-danger">
        Couldn’t load your add-ons: {error}
      </div>
    );
  if (plugins.length === 0)
    return (
      <p className="text-sm text-helios-dim">
        You haven’t installed any add-ons yet. Find some under <span className="text-asu-gold">Browse</span>.
      </p>
    );

  return (
    <ul className="space-y-2">
      {plugins.map((p) => {
        const updatable = hasUpdate(p);
        const busy = busyId === p.id;
        return (
          <li
            key={p.id}
            className="flex flex-wrap items-center gap-3 rounded-md border border-helios-line bg-helios-panel p-3"
          >
            <button
              type="button"
              onClick={() => onOpenDetail(p)}
              className="min-w-0 flex-1 text-left focus-visible:outline-none"
              aria-label={`Details for ${p.name}`}
            >
              <div className="flex items-center gap-1.5">
                {p.isRecommended && (
                  <IconStarFilled size={11} className="shrink-0 text-asu-gold" aria-label="Recommended" />
                )}
                <span className="truncate font-medium text-helios-text">{p.name}</span>
                {p.subteam && (
                  <span className="shrink-0 text-[10px] uppercase tracking-wider text-helios-dim">
                    · {p.subteam}
                  </span>
                )}
              </div>
              <div className="mt-0.5 text-[11px] text-helios-dim">
                Installed v{p.installedVersion}
                {updatable && <span className="text-asu-gold"> · v{p.version} available</span>}
              </div>
            </button>

            <div className="flex shrink-0 items-center gap-2">
              {updatable && (
                <button
                  type="button"
                  onClick={() => onUpdate(p)}
                  disabled={busy}
                  className="inline-flex items-center gap-1 rounded-sm bg-asu-gold px-2.5 py-1.5 text-xs font-semibold text-helios-base transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-50"
                >
                  <IconArrowUp size={13} /> Update
                </button>
              )}
              <button
                type="button"
                onClick={() => onOpen(p)}
                disabled={busy}
                className="inline-flex items-center gap-1 rounded-sm border border-asu-gold/60 px-2.5 py-1.5 text-xs font-semibold text-asu-gold transition-colors hover:bg-asu-gold/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-50"
              >
                <IconPlayerPlay size={13} /> Open
              </button>
              <button
                type="button"
                onClick={() => onUninstall(p)}
                disabled={busy}
                aria-label={`Uninstall ${p.name}`}
                className="inline-flex items-center gap-1 rounded-sm border border-helios-line px-2 py-1.5 text-xs text-helios-dim transition-colors hover:border-helios-danger/50 hover:text-helios-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-helios-danger disabled:opacity-50"
              >
                <IconTrash size={13} />
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
