// Install-time consent. EVERY install goes through this modal first: it lays out
// exactly what the add-on is allowed to do (from the manifest's declared
// permissions) before the user commits. For a high-trust (Tier-2) add-on — one
// that can reach OUTSIDE the sandbox, e.g. run MATLAB on the machine — it adds an
// unmissable red banner. The container only calls `useInstall` from this modal's
// confirm, so consent cannot be skipped.

import { IconAlertTriangle, IconX, IconLoader2 } from "@tabler/icons-react";
import type { AvailablePlugin } from "../data/useMarketplace";
import { PermissionList, hasHighTrust } from "./PermissionList";

export function InstallConsentModal({
  plugin,
  installing,
  error,
  onConfirm,
  onCancel,
}: {
  plugin: AvailablePlugin;
  installing: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const highTrust = hasHighTrust(plugin.permissions);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Install ${plugin.name}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-md border border-helios-line bg-helios-panel shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-helios-line px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-helios-text">Install “{plugin.name}”</h2>
            <p className="mt-0.5 text-[11px] text-helios-dim">
              Version {plugin.version}
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
          {highTrust && (
            <div className="flex items-start gap-2 rounded-sm border border-helios-danger/50 bg-helios-danger/15 p-3">
              <IconAlertTriangle size={18} className="mt-0.5 shrink-0 text-helios-danger" />
              <div className="text-xs text-helios-text">
                <div className="font-semibold text-helios-danger">This add-on can run code outside the sandbox.</div>
                <p className="mt-0.5 text-[11px] text-helios-dim">
                  It requests a high-trust capability that runs native programs on this computer with
                  your privileges. Only install add-ons you trust and that have been reviewed.
                </p>
              </div>
            </div>
          )}

          <div>
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-helios-dim">
              This add-on will be able to
            </div>
            <PermissionList permissions={plugin.permissions} mode="detail" />
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
            disabled={installing}
            className="rounded-sm px-3 py-1.5 text-xs text-helios-dim transition-colors hover:text-helios-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={installing}
            className={
              "inline-flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-xs font-semibold transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-60 " +
              (highTrust
                ? "bg-helios-danger text-white hover:opacity-90"
                : "bg-asu-gold text-helios-base hover:opacity-90")
            }
          >
            {installing && <IconLoader2 size={14} className="animate-spin" />}
            {installing ? "Installing…" : highTrust ? "Install anyway" : "Install"}
          </button>
        </div>
      </div>
    </div>
  );
}
