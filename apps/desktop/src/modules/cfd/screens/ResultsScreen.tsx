import { useCfd } from "../state/CfdContext";
import { SingleRpmResults } from "../results/SingleRpmResults";
import { SweepResults } from "../results/SweepResults";
import { OptimizationResults } from "../results/OptimizationResults";

export function ResultsScreen() {
  const { state, navigateTo } = useCfd();
  const activeStudy = state.activeStudyId ? state.studies[state.activeStudyId] : null;

  if (!activeStudy) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-helios-base text-helios-dim">
        <p className="mb-4 text-[11px] uppercase tracking-wider text-[#5A5F66]">No study selected</p>
        <button
          type="button"
          className="rounded-sm bg-[#FFC627] px-3 py-1 text-[10px] uppercase tracking-wider text-[#0E0E10] hover:bg-yellow-300"
          onClick={() => navigateTo("studies")}
        >
          Go to studies
        </button>
      </div>
    );
  }

  // Remount the result subtree on study switch: the per-kind screens hold
  // local UI state (expanded rows, compare selection, zoom, chart instances)
  // that must NOT leak across studies. Keying on the study id forces a fresh
  // mount instead of an in-place re-render with stale state.
  switch (activeStudy.kind) {
    case "single-rpm":
      return <SingleRpmResults key={activeStudy.id} study={activeStudy} />;
    case "sweep":
      return <SweepResults key={activeStudy.id} study={activeStudy} />;
    case "optimization":
      return <OptimizationResults key={activeStudy.id} study={activeStudy} />;
    default:
      return <div className="p-4 text-[#9097A0]">Unknown study kind.</div>;
  }
}
