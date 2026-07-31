// Uninstall confirmation. The mirror of InstallConsentModal (same dialog shell,
// same button grammar) for the other end of the lifecycle: uninstall deregisters
// the add-on server-side, deletes its downloaded bundle, and drops everything it
// stored — none of which is undoable. Before this, that was ONE click on an
// unlabeled trash icon sitting next to "Open". Under an accidents-not-malice model
// that's the highest-value guard in the marketplace, so the destructive action now
// names the add-on and spells out what goes with it.

import { IconAlertTriangle, IconX, IconLoader2 } from "@tabler/icons-react";
import type { AvailablePlugin } from "../data/useMarketplace";

export function UninstallConfirmModal({
  plugin,
  removing,
  error,
  onConfirm,
  onCancel,
}: {
  plugin: AvailablePlugin;
  removing: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Uninstall ${plugin.name}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-md border border-helios-line bg-helios-panel shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-helios-line px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-helios-text">Uninstall “{plugin.name}”?</h2>
            <p className="mt-0.5 text-[11px] text-helios-dim">
              Installed <span className="font-mono">v{plugin.installedVersion ?? plugin.version}</span>
              {plugin.subteam ? ` · ${plugin.subteam}` : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            className="rounded-sm p-1 text-helios-dim transition-colors hover:text-helios-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
          >
            <IconX size={16} />
          </button>
        </div>

        <div className="max-h-[60vh] space-y-3 overflow-y-auto px-4 py-3">
          <div className="flex items-start gap-2 rounded-sm border border-helios-danger/50 bg-helios-danger/15 p-3">
            <IconAlertTriangle size={18} className="mt-0.5 shrink-0 text-helios-danger" />
            <div className="text-xs text-helios-text">
              <div className="font-semibold text-helios-danger">This can’t be undone.</div>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-helios-dim">
                <li>The add-on is removed from your installed list and stops appearing in Helios.</li>
                <li>Its downloaded bundle is deleted from this computer.</li>
                <li>
                  Everything it saved for you — its settings and any inputs you typed into it — is
                  erased.
                </li>
              </ul>
              <p className="mt-1.5 text-[11px] text-helios-dim">
                You can install it again from Browse, but it will start fresh.
              </p>
            </div>
          </div>

          {error && (
            <div className="rounded-sm border border-helios-danger/40 bg-helios-danger/10 p-2 text-[11px] text-helios-danger">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-helios-line px-4 py-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={removing}
            className="rounded-sm px-3 py-1.5 text-xs text-helios-dim transition-colors hover:text-helios-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-50"
          >
            Keep it
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={removing}
            className="inline-flex items-center gap-1.5 rounded-sm bg-helios-danger px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-helios-danger disabled:opacity-60"
          >
            {removing && <IconLoader2 size={14} className="animate-spin" />}
            {removing ? "Uninstalling…" : "Uninstall"}
          </button>
        </div>
      </div>
    </div>
  );
}
