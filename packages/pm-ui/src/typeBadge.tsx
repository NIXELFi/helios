import type { TaskType } from "./types";

const LABEL: Record<TaskType, string> = {
  part: "Part",
  drawing: "Drawing",
  simulation: "Simulation",
  assembly: "Assembly",
  analysis: "Analysis",
  test: "Test",
  general: "General",
  mfg_laser: "MFG-LZR",
  mfg_machine: "MFG-MCH",
  mfg_weld: "MFG-WELD",
};

// Compact labels for space-constrained surfaces (e.g. Gantt bars). Shorthand is
// only applied where the full label is > 4 letters; shorter labels are kept as
// is. The MFG-* codes are already compact.
const SHORT: Record<TaskType, string> = {
  part: "Part",
  drawing: "DRAW",
  simulation: "SIM",
  assembly: "ASSY",
  analysis: "ANLS",
  test: "Test",
  general: "GEN",
  mfg_laser: "MFG-LZR",
  mfg_machine: "MFG-MCH",
  mfg_weld: "MFG-WELD",
};

const TONE: Record<TaskType, string> = {
  part: "border-blue-400/40 text-blue-300",
  drawing: "border-violet-400/40 text-violet-300",
  simulation: "border-emerald-400/40 text-emerald-300",
  assembly: "border-asu-gold/60 text-asu-gold",
  analysis: "border-orange-400/40 text-orange-300",
  test: "border-pink-400/40 text-pink-300",
  general: "border-helios-line text-helios-dim",
  mfg_laser: "border-cyan-400/40 text-cyan-300",
  mfg_machine: "border-amber-400/40 text-amber-300",
  mfg_weld: "border-orange-400/40 text-orange-300",
};

export function TypeBadge({ type }: { type: TaskType }) {
  return (
    <span
      className={
        "inline-flex items-center rounded-sm border bg-transparent px-1.5 py-0 text-[10px] font-medium uppercase tracking-widest " +
        TONE[type]
      }
    >
      {LABEL[type]}
    </span>
  );
}

export const TASK_TYPE_LABEL = LABEL;
export const TASK_TYPE_SHORT = SHORT;
