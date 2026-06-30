// Plugin detail — one add-on in full: description, the complete permission
// breakdown (the trust surface), version/publish info, and the same install /
// open / update / uninstall actions as the list views. `useAvailablePlugins`
// returns the newest approved version per plugin, so that's what's shown here; a
// full per-version history needs its own RPC and is left for a later pass.

import { IconArrowLeft, IconStarFilled, IconPlayerPlay, IconArrowUp, IconTrash } from "@tabler/icons-react";
import type { AvailablePlugin } from "../data/useMarketplace";
import { PermissionList } from "../components/PermissionList";
import { hasUpdate } from "../lib/version";

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

export function PluginDetail({
  plugin,
  busy,
  onBack,
  onRequestInstall,
  onUpdate,
  onOpen,
  onUninstall,
}: {
  plugin: AvailablePlugin;
  busy: boolean;
  onBack: () => void;
  onRequestInstall: (plugin: AvailablePlugin) => void;
  onUpdate: (plugin: AvailablePlugin) => void;
  onOpen: (plugin: AvailablePlugin) => void;
  onUninstall: (plugin: AvailablePlugin) => void;
}) {
  const installed = plugin.installedVersion !== null;
  const updatable = hasUpdate(plugin);

  return (
    <div className="mx-auto max-w-2xl">
      <button
        type="button"
        onClick={onBack}
        className="mb-4 inline-flex items-center gap-1 rounded-sm px-2 py-1 text-xs text-helios-dim transition-colors hover:text-asu-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
      >
        <IconArrowLeft size={14} /> Marketplace
      </button>

      <div className="rounded-md border border-helios-line bg-helios-panel p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              {plugin.isRecommended && (
                <IconStarFilled size={14} className="shrink-0 text-asu-gold" aria-label="Recommended" />
              )}
              <h2 className="text-lg font-semibold text-helios-text">{plugin.name}</h2>
            </div>
            {plugin.subteam && (
              <div className="mt-0.5 text-[10px] uppercase tracking-wider text-helios-dim">
                {plugin.subteam}
              </div>
            )}
          </div>
          <div className="shrink-0 text-right text-[11px] text-helios-dim">
            <div>v{plugin.version}</div>
            <div>Published {formatDate(plugin.publishedAt)}</div>
          </div>
        </div>

        {plugin.manifest.description && (
          <p className="mt-3 text-sm text-helios-dim">{plugin.manifest.description}</p>
        )}

        <div className="mt-5">
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-helios-dim">
            Permissions
          </h3>
          <PermissionList permissions={plugin.permissions} mode="detail" />
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-helios-line pt-4">
          {!installed && (
            <button
              type="button"
              onClick={() => onRequestInstall(plugin)}
              disabled={busy}
              className="rounded-sm bg-asu-gold px-4 py-2 text-xs font-semibold text-helios-base transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-50"
            >
              Install
            </button>
          )}
          {installed && (
            <>
              <button
                type="button"
                onClick={() => onOpen(plugin)}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-sm border border-asu-gold/60 px-4 py-2 text-xs font-semibold text-asu-gold transition-colors hover:bg-asu-gold/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-50"
              >
                <IconPlayerPlay size={14} /> Open
              </button>
              {updatable && (
                <button
                  type="button"
                  onClick={() => onUpdate(plugin)}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-sm bg-asu-gold px-4 py-2 text-xs font-semibold text-helios-base transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-50"
                >
                  <IconArrowUp size={14} /> Update to v{plugin.version}
                </button>
              )}
              <button
                type="button"
                onClick={() => onUninstall(plugin)}
                disabled={busy}
                className="ml-auto inline-flex items-center gap-1.5 rounded-sm border border-helios-line px-3 py-2 text-xs text-helios-dim transition-colors hover:border-helios-danger/50 hover:text-helios-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-helios-danger disabled:opacity-50"
              >
                <IconTrash size={14} /> Uninstall
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
