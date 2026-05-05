import { useEffect, type RefObject } from "react";

/** Calls `onResize` whenever the observed element changes size. The callback
 *  is invoked once on mount with the initial size so first-paint widths/heights
 *  are correct even before any user interaction. */
export function useResizeObserver(
  ref: RefObject<HTMLElement | null>,
  onResize: (entry: { width: number; height: number }) => void,
): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof ResizeObserver === "undefined") {
      // jsdom and some test environments lack ResizeObserver; fire once with the
      // current bounding rect so widgets still render their empty state.
      const r = el.getBoundingClientRect();
      onResize({ width: r.width, height: r.height });
      return;
    }
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const cr = e.contentRect;
        onResize({ width: cr.width, height: cr.height });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, onResize]);
}
