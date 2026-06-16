interface Props {
  /** 0..1 progress fraction. */
  progress: number;
  /** Short label for the current step (e.g. "Loading Driver tryout 4/16…"). */
  stage: string;
  /** Optional error to surface in place of the spinner. */
  error?: string | null;
  /** App version string, surfaced in the bottom strip. Passed in (rather
   *  than imported) so this component stays trivially testable. */
  version?: string;
  /** When provided, the error/empty state renders an "Open CSV" button that
   *  invokes this — so a Logs tab with no data isn't a dead end. */
  onOpenFile?: () => void;
}

/** Splash/loading screen shown while sessions and math channels are being
 *  computed. Static wordmark + subtitle, plus a real progress bar driven by
 *  the loader's `onProgress` callback. The bar has a subtle sliding-highlight
 *  overlay so it still feels alive between discrete progress events. */
export function LoadingScreen({ progress, stage, error, version, onOpenFile }: Props) {
  const pct = Math.max(0, Math.min(1, progress));
  return (
    // `absolute` (not `fixed`): this fills its module pane, NOT the whole
    // viewport — so when the Logs tab has no data the module rail stays visible
    // and the user can switch to Vault / CFD (which don't need a CSV).
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-helios-base text-helios-text">
      <div className="helios-splash-in relative flex flex-col items-center gap-3">
        {/* Soft gold halo behind the wordmark for depth. */}
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 h-80 w-80 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{ background: "radial-gradient(circle, rgba(255,198,39,0.12) 0%, transparent 70%)" }}
        />
        <h1
          className="font-helios text-[5rem] leading-none text-asu-gold md:text-[7rem]"
          style={{ textShadow: "0 0 48px rgba(255,198,39,0.25)" }}
        >
          HELIOS
        </h1>
        <div className="text-[10px] uppercase tracking-[0.4em] text-helios-dim md:text-xs">
          Sun Devil Motorsports · Ground Station
        </div>
      </div>

      <div className="mt-12 flex w-[520px] max-w-[80%] flex-col gap-2">
        {error ? (
          <div className="flex flex-col items-center gap-4">
            <div role="alert" className="w-full rounded-sm border border-helios-danger bg-helios-panel px-3 py-2 text-center text-xs text-helios-danger">
              {error}
            </div>
            {onOpenFile && (
              <button
                type="button"
                onClick={onOpenFile}
                className="rounded-sm border border-asu-gold px-5 py-2 text-xs uppercase tracking-wider text-asu-gold transition-colors hover:bg-asu-gold hover:text-helios-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
              >
                Open CSV…
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="flex items-baseline justify-between text-[10px] uppercase tracking-wider text-helios-dim">
              <span className="truncate">{stage}</span>
              <span className="ml-2 flex-shrink-0 font-mono-num text-asu-gold">
                {Math.round(pct * 100)}%
              </span>
            </div>
            <div
              role="progressbar"
              aria-label={stage}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(pct * 100)}
              className="relative h-1.5 overflow-hidden rounded-full border border-helios-line bg-helios-panel"
            >
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-asu-gold transition-[width] duration-300 ease-out"
                style={{ width: `${pct * 100}%` }}
              >
                <div
                  className="absolute inset-0 helios-bar-slide"
                  style={{
                    background:
                      "linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.45) 50%, transparent 100%)",
                  }}
                  aria-hidden
                />
              </div>
            </div>
          </>
        )}
      </div>

      <div className="absolute bottom-4 left-0 right-0 text-center text-[10px] uppercase tracking-wider text-helios-dim/70">
        v{version ?? "dev"} · ground-station
      </div>
    </div>
  );
}
