/** Read the canvas's logical size, preferring getBoundingClientRect but
 *  falling back to clientWidth/Height (and then offsetWidth/Height) when the
 *  rect is 0×0. This matters on first paint: a ResizeObserver may notify with
 *  a 0×0 contentRect before layout flushes, and we don't want widgets to
 *  paint a blank canvas in that window. clientWidth/offsetWidth are populated
 *  earlier in the layout pipeline. */
function resolveCanvasSize(canvas: HTMLCanvasElement): { w: number; h: number } {
  const rect = canvas.getBoundingClientRect();
  let w = rect.width;
  let h = rect.height;
  if (w <= 0 || h <= 0) {
    if (canvas.clientWidth > 0) w = canvas.clientWidth;
    if (canvas.clientHeight > 0) h = canvas.clientHeight;
  }
  if (w <= 0 || h <= 0) {
    if (canvas.offsetWidth > 0) w = canvas.offsetWidth;
    if (canvas.offsetHeight > 0) h = canvas.offsetHeight;
  }
  // Last resort: walk to the parent. The canvas might still be in a frame
  // where it hasn't picked up its `w-full h-full` styles, but the parent
  // tile has known dimensions.
  if ((w <= 0 || h <= 0) && canvas.parentElement) {
    const p = canvas.parentElement.getBoundingClientRect();
    if (w <= 0 && p.width > 0) w = p.width;
    if (h <= 0 && p.height > 0) h = p.height;
  }
  return { w, h };
}

/** Configure a canvas 2D context for crisp rendering on high-DPI displays. */
export function setupCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const dpr = window.devicePixelRatio || 1;
  const { w, h } = resolveCanvasSize(canvas);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  return ctx;
}

/** Logical (CSS) size of a canvas, regardless of devicePixelRatio. Uses the
 *  same fallback chain as setupCanvas so widgets see consistent dimensions
 *  for sizing vs drawing. */
export function canvasLogicalSize(canvas: HTMLCanvasElement): { w: number; h: number } {
  return resolveCanvasSize(canvas);
}

/** Pick the right text color for a value given warn/alarm thresholds.
 *
 *  Thresholds come in high and low pairs because plenty of motorsport channels
 *  alarm on the way *down* — oil pressure, fuel pressure, battery voltage — and
 *  some (e.g. a target-window channel) alarm on both sides at once. The two
 *  sides are independent tests; severity, not side, decides the color, so any
 *  alarm outranks any warn. All four bounds are optional: pass only the sides
 *  that apply. Comparisons are inclusive, so a value sitting exactly on a
 *  threshold is already in that band. */
export function thresholdColor(
  v: number | null,
  warn?: number,
  alarm?: number,
  warnLow?: number,
  alarmLow?: number,
): string {
  if (v === null) return "#7B8088";
  if (alarm !== undefined && v >= alarm) return "#EF5350";
  if (alarmLow !== undefined && v <= alarmLow) return "#EF5350";
  if (warn !== undefined && v >= warn) return "#FFB800";
  if (warnLow !== undefined && v <= warnLow) return "#FFB800";
  return "#D8DCE2";
}
