import { IconStarFilled, IconPencil, IconFileText } from "@tabler/icons-react";
import { formatBytes } from "../lib/chart-utils";
import type { VaultFile } from "../data/types";

/** Hero card at the top of Insights spotlighting the vault's flagship file (its
 *  master assembly). Read-only for everyone; admins get a "Change" affordance
 *  that opens the picker. `file` is null when nothing is spotlighted (or the
 *  stored id no longer resolves). */
export function SpotlightCard({
  file,
  path,
  authorLabel,
  canEdit,
  onChange,
}: {
  file: VaultFile | null;
  path: string;
  authorLabel: string | null;
  canEdit: boolean;
  onChange: () => void;
}) {
  const rev = file?.latest?.revision;
  const versions = file?.latest?.version_num ?? 0;
  const size = file?.latest?.size_bytes ?? 0;
  const updated = file?.latest?.created_at ?? file?.created_at ?? null;

  return (
    <div className="relative overflow-hidden rounded-lg border border-asu-gold/40 bg-gradient-to-br from-asu-gold/10 via-helios-panel to-helios-panel p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-asu-gold">
          <IconStarFilled size={13} />
          Spotlight
        </div>
        {canEdit ? (
          <button
            type="button"
            onClick={onChange}
            className="inline-flex items-center gap-1 rounded border border-helios-line bg-helios-base/60 px-2 py-1 text-xs text-helios-dim transition-colors hover:border-asu-gold hover:text-helios-text"
          >
            <IconPencil size={13} strokeWidth={1.5} />
            {file ? "Change" : "Choose"}
          </button>
        ) : null}
      </div>

      {file ? (
        <div className="mt-3 flex items-start gap-4">
          <div className="grid size-12 shrink-0 place-items-center rounded-md border border-asu-gold/30 bg-asu-gold/10 text-asu-gold">
            <IconFileText size={24} strokeWidth={1.5} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-lg font-semibold text-helios-text" title={file.name}>
              {file.name}
            </h2>
            <p className="truncate text-xs text-helios-dim" title={path || "(vault root)"}>
              {path || "(vault root)"}
            </p>
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs">
              <Stat label="Revision" value={rev != null ? `Rev ${rev}` : `v${versions}`} />
              <Stat label="Versions" value={String(versions)} />
              <Stat label="Size" value={formatBytes(size)} />
              {updated ? <Stat label="Updated" value={new Date(updated).toLocaleDateString()} /> : null}
              {authorLabel ? <Stat label="By" value={authorLabel} /> : null}
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-3 text-sm text-helios-dim">
          No spotlight file yet.
          {canEdit ? " Pick this project's master assembly to feature it here." : ""}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wider text-helios-dim/70">{label}</span>
      <span className="font-medium text-helios-text">{value}</span>
    </div>
  );
}
