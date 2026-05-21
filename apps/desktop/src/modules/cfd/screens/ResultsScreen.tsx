import { useCfd } from "../state/CfdContext";
import { SingleRpmResults } from "../results/SingleRpmResults";

export function ResultsScreen() {
  const { state, navigateTo } = useCfd();
  const activeStudy = state.activeStudyId ? state.studies[state.activeStudyId] : null;

  if (!activeStudy) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-helios-dim">
        <p className="mb-4 text-sm">Pick a study on the left, or start a new one.</p>
        <button
          type="button"
          className="rounded bg-asu-gold px-3 py-1.5 text-sm font-medium text-helios-base hover:bg-yellow-300"
          onClick={() => navigateTo("studies")}
        >
          Go to studies
        </button>
      </div>
    );
  }

  // Dispatch on study.kind — future kinds get their own renderer here.
  switch (activeStudy.kind) {
    case "single-rpm":
      return <SingleRpmResults study={activeStudy} />;
    default:
      return <div className="p-4 text-helios-dim">Unknown study kind.</div>;
  }
}
