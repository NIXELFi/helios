import { useEffect, useRef } from "react";

/**
 * Run `handler` when the window regains focus, but at most once every
 * `minIntervalMs`.
 *
 * Alt-tabbing used to fire a full PM workspace pull, a marketplace refetch and
 * a whole-folder disk walk on EVERY focus event — a storm that a user flicking
 * between Helios and SOLIDWORKS repeats dozens of times an hour (load audit
 * 2026-09-09, finding 7). The first focus always runs; the ones that follow
 * inside the window are dropped.
 *
 * The handler is kept in a ref, so passing an inline arrow does not re-subscribe
 * the listener on every render.
 */
export function useThrottledFocus(handler: () => void, minIntervalMs: number, enabled = true) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  // Survives the enabled/interval re-subscribe below, so toggling `enabled`
  // can't be used to bypass the throttle.
  const lastRunRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const onFocus = () => {
      const now = Date.now();
      if (lastRunRef.current !== 0 && now - lastRunRef.current < minIntervalMs) return;
      lastRunRef.current = now;
      handlerRef.current();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [enabled, minIntervalMs]);
}
