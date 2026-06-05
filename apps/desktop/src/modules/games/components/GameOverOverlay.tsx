import { useEffect, useState } from "react";

export type SubmitStatus = "submitting" | "submitted" | "error";

interface Props {
  score: number;
  status: SubmitStatus;
  onRetrySubmit: () => void;
  onRestart: () => void;
  onBack: () => void;
}

/** Count up from 0 to `target` over ~500ms; snaps instantly under reduced motion. */
function useCountUp(target: number): number {
  const [value, setValue] = useState(target);

  useEffect(() => {
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced || target <= 0) {
      setValue(target);
      return;
    }
    setValue(0);
    const duration = 500;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(target * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);

  return value;
}

export function GameOverOverlay({ score, status, onRetrySubmit, onRestart, onBack }: Props) {
  const shown = useCountUp(score);

  return (
    {/* rounded-md so the backdrop hugs the .games-crt bezel's radius */}
    <div className="games-overlay-in absolute inset-0 flex items-center justify-center rounded-md bg-helios-base/85 backdrop-blur-sm">
      <div className="games-card-in relative w-72 overflow-hidden rounded-md border border-helios-line bg-helios-panel text-center shadow-[0_24px_60px_-20px_rgba(0,0,0,0.9)] ring-1 ring-black/60">
        {/* Hazard trim along the top edge */}
        <div className="games-hazard h-1.5 w-full" />

        <div className="flex flex-col gap-3 p-5">
          <div className="games-display-heavy games-flicker text-xl tracking-[0.28em] text-asu-gold">
            GAME OVER
          </div>

          <div className="flex flex-col gap-0.5">
            <div className="games-display text-[10px] tracking-[0.2em] text-helios-dim">
              FINAL SCORE
            </div>
            <div className="games-num text-5xl font-bold leading-none text-helios-text">
              {shown}
            </div>
          </div>

          <div className="min-h-[16px] text-xs">
            {status === "submitting" && (
              <span className="games-pulse text-helios-dim">Submitting score…</span>
            )}
            {status === "submitted" && (
              <span className="games-num text-[10px] uppercase tracking-wider text-asu-gold">
                Score submitted ✓
              </span>
            )}
            {status === "error" && (
              <span className="text-red-300">
                Submit failed.{" "}
                <button type="button" className="underline" onClick={onRetrySubmit}>
                  Retry
                </button>
              </span>
            )}
          </div>

          <div className="mt-1 flex justify-center gap-2">
            <button
              type="button"
              onClick={onRestart}
              className="games-display rounded-sm border border-asu-gold bg-asu-gold px-3 py-1.5 text-[10px] tracking-wider text-helios-base transition-opacity hover:opacity-90"
            >
              PLAY AGAIN
            </button>
            <button
              type="button"
              onClick={onBack}
              className="games-display rounded-sm border border-helios-line bg-transparent px-3 py-1.5 text-[10px] tracking-wider text-helios-text transition-colors hover:border-asu-gold"
            >
              ALL GAMES
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
