// Numeric field. Local string draft + commit-on-blur so users can
// type freely (e.g. "67.0e1" → "670") without per-keystroke validation
// flicker. Stored value is always SI (m, K, Pa, ...).

import { useEffect, useState } from "react";
import type { FieldMeta } from "../../lib/sdm26Schema";

interface Props {
  meta: FieldMeta;
  value: unknown;
  error?: string | null;
  onChange: (next: unknown) => void;
}

export function NumberField({ meta, value, error, onChange }: Props) {
  const display = meta.format ? meta.format(value) : value == null ? "" : String(value);
  const [draft, setDraft] = useState<string>(display);
  useEffect(() => { setDraft(display); }, [display]);

  function commit() {
    if (draft.trim() === "" || draft.trim() === "—") {
      onChange(null);
      return;
    }
    const next = meta.formatInverse ? meta.formatInverse(draft) : Number(draft);
    onChange(next);
  }

  const rangeHint = (() => {
    if (meta.min == null || meta.max == null) return null;
    const lo = meta.format ? meta.format(meta.min) : String(meta.min);
    const hi = meta.format ? meta.format(meta.max) : String(meta.max);
    return `${lo} – ${hi}${meta.unit ? " " + meta.unit : ""}`;
  })();

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1">
        <input
          type="text"
          inputMode="decimal"
          aria-label={meta.label}
          className={
            "w-full rounded-sm border bg-[#0B0B0D] px-2 py-1 font-mono text-[11px] text-[#D8DCE2] focus:outline-none " +
            (error
              ? "border-red-500/60 focus:border-red-400"
              : "border-[#2A2C32] focus:border-[#FFC627]")
          }
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commit();
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        {meta.unit && <span className="text-[10px] text-[#5A5F66]">{meta.unit}</span>}
      </div>
      {error ? (
        <div className="text-[10px] text-red-300">{error}</div>
      ) : rangeHint ? (
        <div className="text-[10px] text-[#5A5F66]">{rangeHint}</div>
      ) : null}
    </div>
  );
}
