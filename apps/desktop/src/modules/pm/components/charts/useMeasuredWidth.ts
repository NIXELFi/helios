import { useLayoutEffect, useRef, useState, type RefObject } from "react";

// ---------------------------------------------------------------------------
// Measured, not scaled. Every Productivity chart renders its SVG at a real
// pixel width so 10-11 px labels stay 10-11 px whatever the panel is doing; a
// scaled viewBox turns them into 14 px on a wide window and 7 px in a
// two-column grid. Same pattern as cfd's useElementWidth: a synchronous first
// read, then a ResizeObserver, with `fallback` under jsdom (clientWidth is 0
// there and the observer never fires) so unit tests stay deterministic.
// ---------------------------------------------------------------------------

export function useMeasuredWidth<T extends HTMLElement>(
  fallback = 640,
): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
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
  }, []);

  return [ref, width];
}
