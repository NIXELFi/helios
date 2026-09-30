// Ten years. A longer estimate is a typo, and the critical path walks
// durations, so an unbounded one is not harmless.
export const MAX_ESTIMATE_DAYS = 3650;

/** A typed estimate: null when cleared, undefined when it must be rejected. */
export function parseEstimateDays(raw: string): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0 || n > MAX_ESTIMATE_DAYS) return undefined;
  return n;
}
