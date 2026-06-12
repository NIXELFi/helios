import { useCallback, useEffect, useRef } from "react";

// Module-level so positions survive view unmounts (switching views, leaving
// the PM tab) for the lifetime of the app session. Deliberately NOT
// localStorage: restoring a week-old scroll offset into a list that has since
// changed shape reads as a glitch, not a convenience.
const positions = new Map<string, { top: number; left: number }>();

/**
 * Remembers a scroll container's position under `key` (typically the PM
 * pathname, so each view × scope combination has its own memory) and restores
 * it when the container re-attaches or the key changes on a still-mounted
 * container (same view component switching team scope).
 *
 * Returns a CALLBACK ref so callers with their own callback ref (Gantt's
 * wheel-zoom listener) can compose: `ref={(n) => { mine(n); scrollMem(n); }}`.
 */
export function useScrollMemory(key: string): (node: HTMLElement | null) => void {
  const nodeRef = useRef<HTMLElement | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const keyRef = useRef(key);

  // Key changed while the container stayed mounted → save under the new key
  // from now on, and restore the new key's remembered position.
  useEffect(() => {
    keyRef.current = key;
    const node = nodeRef.current;
    const saved = positions.get(key);
    if (node && saved) {
      node.scrollTop = saved.top;
      node.scrollLeft = saved.left;
    }
  }, [key]);

  return useCallback((node: HTMLElement | null) => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    nodeRef.current = node;
    if (!node) return;
    const saved = positions.get(keyRef.current);
    if (saved) {
      node.scrollTop = saved.top;
      node.scrollLeft = saved.left;
      // The content often finishes laying out a frame after attach (charts,
      // images, virtual rows) which clamps the first restore — re-apply once.
      requestAnimationFrame(() => {
        const want = positions.get(keyRef.current);
        if (want && nodeRef.current === node) {
          if (node.scrollTop !== want.top) node.scrollTop = want.top;
          if (node.scrollLeft !== want.left) node.scrollLeft = want.left;
        }
      });
    }
    const onScroll = () => {
      positions.set(keyRef.current, { top: node.scrollTop, left: node.scrollLeft });
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    cleanupRef.current = () => node.removeEventListener("scroll", onScroll);
  }, []);
}

/** Test helper — clears all remembered positions. */
export function resetScrollMemory(): void {
  positions.clear();
}
