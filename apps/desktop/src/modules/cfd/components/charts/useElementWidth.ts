// Track an element's content-box width via ResizeObserver so the hand-rolled
// SVG charts (ScatterPlot, ParallelCoordsPlot) fill their container instead of
// a hard-coded pixel width — the uPlot charts (LinePlot, CycleChart) already do
// this internally. Returns `fallback` until the first non-zero measurement
// lands, which is also the value used under jsdom (clientWidth is 0 there and
// the test ResizeObserver stub never fires), keeping unit tests deterministic.

import { useLayoutEffect, useState, type RefObject } from "react";

export function useElementWidth<T extends HTMLElement>(
  ref: RefObject<T | null>,
  fallback = 600,
): number {
  const [width, setWidth] = useState(fallback);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Synchronous first read so we paint at the real width immediately rather
    // than flashing the fallback for a frame. 0 (jsdom / detached) keeps it.
    const initial = el.clientWidth;
    if (initial > 0) setWidth(initial);

    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const w = e.contentRect.width;
        if (w > 0) setWidth((prev) => (Math.abs(prev - w) > 0.5 ? w : prev));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);

  return width;
}
