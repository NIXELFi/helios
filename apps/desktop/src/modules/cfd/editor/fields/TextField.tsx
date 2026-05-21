import { useEffect, useState } from "react";
import type { FieldMeta } from "../../lib/sdm26Schema";

interface Props {
  meta: FieldMeta;
  value: unknown;
  error?: string | null;
  onChange: (next: unknown) => void;
}

export function TextField({ meta, value, error, onChange }: Props) {
  const [draft, setDraft] = useState<string>(value == null ? "" : String(value));
  useEffect(() => { setDraft(value == null ? "" : String(value)); }, [value]);
  return (
    <div className="flex flex-col gap-0.5">
      <input
        type="text"
        aria-label={meta.label}
        className={
          "w-full rounded-sm border bg-[#0B0B0D] px-2 py-1 font-mono text-[11px] text-[#D8DCE2] focus:outline-none " +
          (error
            ? "border-red-500/60 focus:border-red-400"
            : "border-[#2A2C32] focus:border-[#FFC627]")
        }
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => onChange(draft)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            onChange(draft);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      {error && <div className="text-[10px] text-red-300">{error}</div>}
    </div>
  );
}
