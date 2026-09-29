import { useEffect, useState, type InputHTMLAttributes } from "react";
import { isPlausibleIsoDate } from "@pm/lib/plausibleDate";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange"> & {
  value: string | null;
  /** Called with a plausible ISO date, or null when cleared. */
  onCommit: (next: string | null) => void;
};

/**
 * A date input that saves as you pick, but never saves the partial years a
 * native date input emits while a year is being typed (0002, 0020, 0202 ...).
 * Those stay a local draft until the year is real; a draft that never becomes
 * real is dropped on blur and the saved value comes back.
 */
export function CommitDateInput({ value, onCommit, onBlur, ...rest }: Props) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => setDraft(value ?? ""), [value]);

  return (
    <input
      {...rest}
      type="date"
      value={draft}
      onChange={(e) => {
        const next = e.target.value;
        setDraft(next);
        if (next === "") onCommit(null);
        else if (isPlausibleIsoDate(next) && next !== value) onCommit(next);
      }}
      onBlur={(e) => {
        if (draft !== "" && !isPlausibleIsoDate(draft)) setDraft(value ?? "");
        onBlur?.(e);
      }}
    />
  );
}
