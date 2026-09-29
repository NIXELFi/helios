// A native <input type="date"> reports every intermediate year while you type
// one ("2" -> 0002, 0020, 0202, 2025), and a value like 0202-08-18 is a valid
// ISO date. Anything that commits on change, or draws one element per day
// between the earliest and latest date (Gantt), must reject these.
export const MIN_PLAUSIBLE_YEAR = 2000;
export const MAX_PLAUSIBLE_YEAR = 2100;

export function isPlausibleIsoDate(value: string | null | undefined): value is string {
  if (!value) return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  return year >= MIN_PLAUSIBLE_YEAR && year <= MAX_PLAUSIBLE_YEAR;
}
