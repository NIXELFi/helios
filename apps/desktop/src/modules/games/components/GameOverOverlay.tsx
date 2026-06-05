export type SubmitStatus = "submitting" | "submitted" | "error";

interface Props {
  score: number;
  status: SubmitStatus;
  onRetrySubmit: () => void;
  onRestart: () => void;
  onBack: () => void;
}

export function GameOverOverlay({ score, status, onRetrySubmit, onRestart, onBack }: Props) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-helios-base/80">
      <div className="flex w-64 flex-col gap-3 rounded-sm border border-helios-line bg-helios-panel p-4 text-center">
        <div className="text-sm uppercase tracking-wider text-helios-dim">Game over</div>
        <div className="text-3xl font-bold text-asu-gold">{score}</div>
        <div className="text-xs text-helios-dim">
          {status === "submitting" && "Submitting score…"}
          {status === "submitted" && "Score submitted ✓"}
          {status === "error" && (
            <span className="text-red-300">
              Submit failed.{" "}
              <button type="button" className="underline" onClick={onRetrySubmit}>
                Retry
              </button>
            </span>
          )}
        </div>
        <div className="flex justify-center gap-2">
          <button
            type="button"
            onClick={onRestart}
            className="rounded-sm border border-asu-gold bg-asu-gold px-3 py-1 text-xs font-semibold text-helios-base"
          >
            Play again
          </button>
          <button
            type="button"
            onClick={onBack}
            className="rounded-sm border border-helios-line bg-helios-panel px-3 py-1 text-xs text-helios-text hover:border-asu-gold"
          >
            All games
          </button>
        </div>
      </div>
    </div>
  );
}
