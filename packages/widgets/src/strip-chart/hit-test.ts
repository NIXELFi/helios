/** Pointer hit-testing helpers for the strip chart. Pure functions, kept out
 *  of render.tsx so they're testable without mounting uPlot. */

/** Find the datum the pointer is grabbing, in PIXEL space.
 *
 *  Datums are stored as microsecond timestamps, but the tolerance has to be
 *  expressed where the user actually aims — on screen. A fixed µs radius
 *  would mean a hair-thin target when zoomed out and a half-chart-wide one
 *  when zoomed in. The caller supplies `toPx` (uPlot's valToPos, same
 *  projection drawDatums uses to place the lines) so the radius stays a
 *  constant grab distance at every zoom level.
 *
 *  Returns the matched datum's timestamp in µs — the identity removeDatum
 *  takes — or null when nothing is within `radiusPx`. Ties resolve to the
 *  earlier datum, which is stable given the emitter keeps datums sorted.
 *  Datums outside the current x-scale can project to a non-finite px, so
 *  those are skipped rather than compared.
 */
export function datumNearPx(
  datumsUs: readonly number[],
  toPx: (timeUs: number) => number,
  xPx: number,
  radiusPx: number,
): number | null {
  if (!Number.isFinite(xPx)) return null;
  let best: number | null = null;
  let bestDist = Infinity;
  for (const timeUs of datumsUs) {
    const px = toPx(timeUs);
    if (!Number.isFinite(px)) continue;
    const dist = Math.abs(px - xPx);
    if (dist <= radiusPx && dist < bestDist) {
      bestDist = dist;
      best = timeUs;
    }
  }
  return best;
}
