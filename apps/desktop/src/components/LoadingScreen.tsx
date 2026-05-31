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
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0E0E10] text-[#D8DCE2]">
      <div className="flex flex-col items-center gap-3">
        <h1 className="font-helios text-[5rem] md:text-[7rem] leading-none text-[#FFC627]">
          HELIOS
        </h1>
        <div className="text-[10px] md:text-xs uppercase tracking-[0.4em] text-[#9097A0]">
          Sun Devil Motorsports · Ground Station
        </div>
      </div>

      <div className="mt-12 w-[520px] max-w-[80%] flex flex-col gap-2">
        {error ? (
          <div className="flex flex-col items-center gap-4">
            <div role="alert" className="w-full border border-[#EF5350] bg-[#16171B] px-3 py-2 text-center text-xs text-[#EF5350]">
              {error}
            </div>
            {onOpenFile && (
              <button
                type="button"
                onClick={onOpenFile}
                className="border border-[#FFC627] px-5 py-2 text-xs uppercase tracking-wider text-[#FFC627] transition-colors hover:bg-[#FFC627] hover:text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFC627]"
              >
                Open CSV…
              </button>
            )}
          </div>
        ) : (
          <>
            <div className="flex items-baseline justify-between text-[10px] uppercase tracking-wider text-[#9097A0]">
              <span className="truncate">{stage}</span>
              <span className="font-mono-num text-[#FFC627] flex-shrink-0 ml-2">
                {Math.round(pct * 100)}%
              </span>
            </div>
            <div
              role="progressbar"
              aria-label={stage}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(pct * 100)}
              className="relative h-1.5 bg-[#16171B] border border-[#2A2C32] overflow-hidden"
            >
              <div
                className="absolute inset-y-0 left-0 bg-[#FFC627] transition-[width] duration-300 ease-out"
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

      <div className="absolute bottom-4 left-0 right-0 text-center text-[10px] uppercase tracking-wider text-[#5A5F66]">
        v{version ?? "dev"} · ground-station
      </div>
    </div>
  );
}
