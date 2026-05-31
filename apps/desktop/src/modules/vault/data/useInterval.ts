import { useEffect, useRef } from "react";

/**
 * Run `callback` every `delay` ms. Pass `delay = null` to disable (no timer).
 *
 * The callback is kept in a ref so changing it (new identity each render) does
 * NOT reset the interval — only changing `delay` re-arms it. This is the
 * standard "declarative setInterval" pattern; we use it for the vault's
 * background poll so a fresh refetch closure each render doesn't restart the
 * clock on every render.
 */
export function useInterval(callback: () => void, delay: number | null): void {
  const saved = useRef(callback);
  useEffect(() => { saved.current = callback; }, [callback]);

  useEffect(() => {
    if (delay === null) return;
    const id = setInterval(() => saved.current(), delay);
    return () => clearInterval(id);
  }, [delay]);
}
