import { useEffect, useState, type InputHTMLAttributes } from "react";
import { isPlausibleIsoDate } from "@pm/lib/plausibleDate";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange"> & {
  value: string | null;
  /**
   * Called with a plausible ISO date, or null when cleared. Return false to
   * reject it (e.g. start after due); the field then shows the saved value.
   */
  onCommit: (next: string | null) => boolean | void;
};

/**
 * A date input that saves as you pick, but never saves the partial years a
 * native date input emits while a year is being typed (0002, 0020, 0202 ...).
 * Those stay a local draft until the year is real; a draft that never becomes
 * real is dropped on blur and the saved value comes back.
 *
 * Chromium also reports "" while any one segment is blank (backspacing just
 * the day), flagged by validity.badInput. That is a partial edit, not a clear.
 */
export function CommitDateInput({ value, onCommit, onBlur, ...rest }: Props) {
  const saved = value ?? "";
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);

  return (
    <input
      {...rest}
      type="date"
      value={draft}
      onChange={(e) => {
        const next = e.target.value;
        setDraft(next);
        if (next === "") {
          if (!e.currentTarget.validity?.badInput && value !== null) {
            if (onCommit(null) === false) setDraft(saved);
          }
        } else if (isPlausibleIsoDate(next) && next !== value) {
          if (onCommit(next) === false) setDraft(saved);
        }
      }}
      onBlur={(e) => {
        // Anything still unsaved (unfinished year, half-blanked date) reverts.
        if (draft !== saved) setDraft(saved);
        onBlur?.(e);
      }}
    />
  );
}
