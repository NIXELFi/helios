import type { ReactNode } from "react";
import { tca } from "@helios/ui";

/** The HELIOS wordmark + subtitle, with the soft gold halo. Shared by every
 *  full-pane loading surface (boot landing, module chunk fallback, PM's first
 *  workspace pull, the Logs session loader) so the app boots through ONE
 *  continuous branded screen instead of three different "Loading…" panes. */
export function Wordmark({ animate = true }: { animate?: boolean }) {
  return (
    <div className={(animate ? "helios-splash-in " : "") + "relative flex flex-col items-center gap-3"}>
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 h-80 w-80 -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{ background: `radial-gradient(circle, ${tca("gold", 0.12)} 0%, transparent 70%)` }}
      />
      <h1
        className="font-helios text-[5rem] leading-none text-asu-gold md:text-[7rem]"
        style={{ textShadow: `0 0 48px ${tca("gold", 0.25)}` }}
      >
        HELIOS
      </h1>
      <div className="text-[10px] uppercase tracking-[0.4em] text-helios-dim md:text-xs">
        Sun Devil Motorsports · Ground Station
      </div>
    </div>
  );
}

interface SplashProps {
  /** One short line under the bar: what is being waited on. */
  stage: string;
  /** Shown in the bottom strip; omit for module-level loaders. */
  version?: string;
  /** Replay the wordmark entrance. Off for the hand-offs between boot stages
   *  so the wordmark stays put while only the stage line changes. */
  animate?: boolean;
  /** Extra content under the bar (an error, a retry button). */
  children?: ReactNode;
}

/** Full-pane branded loading screen with an indeterminate bar. `absolute`
 *  (not `fixed`) so it fills the module pane and the rail stays usable. */
export function Splash({ stage, version, animate = true, children }: SplashProps) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-helios-base text-helios-text">
      <Wordmark animate={animate} />
      <div className="mt-12 flex w-[520px] max-w-[80%] flex-col gap-2">
        <div className="text-center text-[10px] uppercase tracking-wider text-helios-dim">{stage}</div>
        <div
          role="progressbar"
          aria-label={stage}
          className="relative h-1.5 overflow-hidden rounded-full border border-helios-line bg-helios-panel"
        >
          <div
            className="helios-bar-slide absolute inset-y-0 left-0 w-1/3 rounded-full bg-asu-gold/70"
            aria-hidden
          />
        </div>
        {children}
      </div>
      {version && (
        <div className="absolute bottom-4 left-0 right-0 text-center text-[10px] uppercase tracking-wider text-helios-dim/70">
          v{version} · ground-station
        </div>
      )}
    </div>
  );
}
