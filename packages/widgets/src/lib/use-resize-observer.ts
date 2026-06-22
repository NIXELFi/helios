import { useEffect, useRef, type RefObject } from "react";

/** Calls `onResize` whenever the observed element changes size. The callback
 *  is invoked once on mount with the initial size so first-paint widths/heights
 *  are correct even before any user interaction.
 *
 *  The observer is only recreated when the observed *element* changes, not
 *  when `onResize` changes identity. The latest `onResize` is always called
 *  via a ref so callers can pass an inline callback without causing the
 *  observer to disconnect/reconnect on every render. */
export function useResizeObserver(
  ref: RefObject<HTMLElement | null>,
  onResize: (entry: { width: number; height: number }) => void,
): void {
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof ResizeObserver === "undefined") {
      // jsdom and some test environments lack ResizeObserver; fire once with the
      // current bounding rect so widgets still render their empty state.
      const r = el.getBoundingClientRect();
      onResizeRef.current({ width: r.width, height: r.height });
      return;
    }
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const cr = e.contentRect;
        onResizeRef.current({ width: cr.width, height: cr.height });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
}
