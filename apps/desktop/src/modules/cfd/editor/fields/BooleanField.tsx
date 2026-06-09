// Checkbox field for boolean config flags (e.g. the opt-in physics models).
// Null/undefined (absent in the JSON) renders unchecked — absent and false
// are equivalent to the Rust loader, so toggling writes a real boolean.

import type { FieldMeta } from "../../lib/sdm26Schema";

export function BooleanField({
  meta,
  value,
  onChange,
}: {
  meta: FieldMeta;
  value: unknown;
  error: string | null;
  onChange: (next: unknown) => void;
}) {
  const checked = value === true;
  return (
    <label className="flex items-center gap-2 py-0.5">
      <input
        type="checkbox"
        aria-label={meta.label}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3 w-3 accent-[#FFC627]"
      />
      <span className="text-[10px] text-[#9097A0]">{checked ? "on" : "off"}</span>
    </label>
  );
}
