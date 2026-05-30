import type { LoadProgress } from "./load-sample";

/** Convert a {loaded,total} progress report into a [0,1] fraction for the
 *  loading bar. The boot sequence reports against different denominators per
 *  stage (bundled count, then +recents, then +math, then +ready), which made
 *  the raw `loaded/total` jump backward between stages. We clamp to [0,1] and
 *  enforce a monotonic floor so the bar only ever moves forward.
 *
 *  @param p     the latest progress report.
 *  @param floor the highest fraction shown so far (0 at boot). */
export function progressFraction(p: LoadProgress, floor: number): number {
  const total = p.total;
  // A zero / negative / non-finite denominator means "we can't size this" —
  // show complete rather than NaN-ing the bar.
  const raw = total > 0 && Number.isFinite(total) ? p.loaded / total : 1;
  const clamped = Math.max(0, Math.min(1, raw));
  return Math.max(floor, clamped);
}
