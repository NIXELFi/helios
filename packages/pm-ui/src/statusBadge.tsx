import type { TaskStatus } from "./types";

const dotColor: Record<TaskStatus, string> = {
  backlog: "bg-helios-dim",
  designing: "bg-blue-400",
  manufacturing: "bg-amber-400",
  testing: "bg-violet-400",
  needs_review: "bg-asu-gold",
  blocked: "bg-red-400",
  done: "bg-emerald-400",
};

const label: Record<TaskStatus, string> = {
  backlog: "Backlog",
  designing: "Designing",
  manufacturing: "Manufacturing",
  testing: "Testing",
  needs_review: "Needs review",
  blocked: "Blocked",
  done: "Done",
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-helios-text font-normal">
      <span aria-hidden className={`size-2 rounded-full ${dotColor[status]}`} />
      <span>{label[status]}</span>
    </span>
  );
}
