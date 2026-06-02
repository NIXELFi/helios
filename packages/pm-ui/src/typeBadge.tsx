import type { TaskType } from "./types";

const LABEL: Record<TaskType, string> = {
  part: "Part",
  drawing: "Drawing",
  simulation: "Simulation",
  assembly: "Assembly",
  analysis: "Analysis",
  test: "Test",
  general: "General",
};

const TONE: Record<TaskType, string> = {
  part: "border-blue-400/40 text-blue-300",
  drawing: "border-violet-400/40 text-violet-300",
  simulation: "border-emerald-400/40 text-emerald-300",
  assembly: "border-asu-gold/60 text-asu-gold",
  analysis: "border-orange-400/40 text-orange-300",
  test: "border-pink-400/40 text-pink-300",
  general: "border-helios-line text-helios-dim",
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
