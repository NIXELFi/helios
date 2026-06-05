import { useEffect, useRef } from "react";

/** Drives a requestAnimationFrame loop, passing clamped dt (seconds). Halts
 *  while `paused` — on resume, dt restarts from the resume frame so a hidden
 *  tab doesn't deliver one giant catch-up step. */
export function useGameLoop(onFrame: (dt: number) => void, paused: boolean): void {
  const cb = useRef(onFrame);
  cb.current = onFrame;
  useEffect(() => {
    if (paused) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 1 / 20); // clamp hiccups
      last = now;
      cb.current(dt);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [paused]);
}
