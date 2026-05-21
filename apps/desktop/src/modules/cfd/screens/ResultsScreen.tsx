import { useCfd } from "../state/CfdContext";
import { SingleRpmResults } from "../results/SingleRpmResults";

export function ResultsScreen() {
  const { state, navigateTo } = useCfd();
  const activeStudy = state.activeStudyId ? state.studies[state.activeStudyId] : null;

  if (!activeStudy) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-[#0B0B0D] text-[#9097A0]">
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

  // Dispatch on study.kind — future kinds get their own renderer here.
  switch (activeStudy.kind) {
    case "single-rpm":
      return <SingleRpmResults study={activeStudy} />;
    default:
      return <div className="p-4 text-[#9097A0]">Unknown study kind.</div>;
  }
}
