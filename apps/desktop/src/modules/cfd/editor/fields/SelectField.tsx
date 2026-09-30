import type { FieldMeta } from "../../lib/sdm26Schema";

interface Props {
  meta: FieldMeta;
  value: unknown;
  error?: string | null;
  onChange: (next: unknown) => void;
}

export function SelectField({ meta, value, error, onChange }: Props) {
  const options = meta.options ?? [];
  return (
    <div className="flex flex-col gap-0.5">
      <select
        aria-label={meta.label}
        className={
          "w-full rounded-sm border bg-helios-deep px-2 py-1 font-mono text-[11px] text-helios-text focus:outline-none " +
          (error
            ? "border-red-500/60 focus:border-red-400"
            : "border-helios-line focus:border-asu-gold")
        }
        value={value == null ? "" : String(value)}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {error && <div className="text-[10px] text-red-300">{error}</div>}
    </div>
  );
}
