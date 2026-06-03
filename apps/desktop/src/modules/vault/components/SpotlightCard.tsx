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
    <div className="border border-l-2 border-helios-line border-l-asu-gold bg-helios-panel">
      <div className="flex items-center justify-between border-b border-helios-line px-4 py-2">
        <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-widest text-asu-gold">
          <IconStarFilled size={12} />
          Spotlight
        </div>
        {canEdit ? (
          <button
            type="button"
            onClick={onChange}
            className="inline-flex items-center gap-1 border border-helios-line bg-helios-base px-2 py-1 text-xs text-helios-dim transition-colors hover:border-asu-gold hover:text-helios-text"
          >
            <IconPencil size={13} strokeWidth={1.5} />
            {file ? "Change" : "Choose"}
          </button>
        ) : null}
      </div>

      {file ? (
        <div className="flex items-start gap-3 p-4">
          <div className="grid size-10 shrink-0 place-items-center border border-asu-gold/40 bg-asu-gold/5 text-asu-gold">
            <IconFileText size={20} strokeWidth={1.5} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold text-helios-text" title={file.name}>
              {file.name}
            </h2>
            <p className="truncate font-mono-num text-[11px] text-helios-dim" title={path || "(vault root)"}>
              {path || "(vault root)"}
            </p>
            <div className="mt-3 flex flex-wrap gap-x-8 gap-y-1.5">
              <Stat label="Revision" value={rev != null ? `Rev ${rev}` : `v${versions}`} />
              <Stat label="Versions" value={String(versions)} />
              <Stat label="Size" value={formatBytes(size)} />
              {updated ? <Stat label="Updated" value={new Date(updated).toLocaleDateString()} /> : null}
              {authorLabel ? <Stat label="By" value={authorLabel} /> : null}
            </div>
          </div>
        </div>
      ) : (
        <div className="p-4 text-sm text-helios-dim">
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
      <span className="text-[9px] uppercase tracking-widest text-helios-dim/70">{label}</span>
      <span className="font-mono-num text-sm font-medium tabular-nums text-helios-text">{value}</span>
    </div>
  );
}
