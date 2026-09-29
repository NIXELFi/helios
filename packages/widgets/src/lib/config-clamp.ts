/* Clamps for numeric widget-config fields that drive work or can throw.
 * Applied both where the value is typed (config editors) and where it is used
 * (render), so a value persisted in an old / hand-edited workspace is bounded
 * too.
 */

/** Largest `decimals` the config editors accept. */
export const MAX_EDITOR_DECIMALS = 6;
/** Render-side ceiling: generous so any value an older editor could save still
 *  renders as before, but far inside toFixed's 0..100 (it throws RangeError
 *  outside that). */
export const MAX_RENDER_DECIMALS = 20;

/** Decimals as typed: integer in [0, MAX_EDITOR_DECIMALS]; blank / junk → 0. */
export function clampEditorDecimals(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(MAX_EDITOR_DECIMALS, Math.round(n)));
}

/** Decimals at use: integer in [0, MAX_RENDER_DECIMALS]; missing / junk → 0
 *  (what toFixed(undefined) did before). */
export function safeDecimals(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(MAX_RENDER_DECIMALS, Math.round(v)));
}

/** Engine-bar segment count bounds. The bar redraws per cursor tick with one
 *  fillRect per segment, so an unbounded count stalls the UI. */
export const MIN_SEGMENTS = 1;
export const MAX_SEGMENTS = 200;
export const DEFAULT_SEGMENTS = 30;

export function clampSegments(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return DEFAULT_SEGMENTS;
  return Math.max(MIN_SEGMENTS, Math.min(MAX_SEGMENTS, Math.round(n)));
}
