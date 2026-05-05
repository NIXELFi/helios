/** Configure a canvas 2D context for crisp rendering on high-DPI displays. */
export function setupCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  return ctx;
}

/** Logical (CSS) size of a canvas, regardless of devicePixelRatio. */
export function canvasLogicalSize(canvas: HTMLCanvasElement): { w: number; h: number } {
  const rect = canvas.getBoundingClientRect();
  return { w: rect.width, h: rect.height };
}

/** Pick the right text color for a value given warn/alarm thresholds. */
export function thresholdColor(v: number | null, warn?: number, alarm?: number): string {
  if (v === null) return "#7B8088";
  if (alarm !== undefined && v >= alarm) return "#EF5350";
  if (warn !== undefined && v >= warn) return "#FFB800";
  return "#D8DCE2";
}
