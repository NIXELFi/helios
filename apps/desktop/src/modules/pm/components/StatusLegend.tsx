import type { TaskOutlineState } from "@helios/pm-ui";

const LEGEND: { state: TaskOutlineState; color: string; label: string }[] = [
  { state: "past_due", color: "#F87171", label: "Past due" },
  { state: "approaching", color: "#FB923C", label: "Due soon" },
  { state: "done", color: "#34D399", label: "Completed" },
  { state: "backlog", color: "#A78BFA", label: "Not started" },
];

// Shared legend for the status-outline color coding used across views.
export function StatusLegend({ className = "" }: { className?: string }) {
  return (
    <div
      className={
        "flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-helios-dim " +
        className
      }
    >
      {LEGEND.map((item) => (
        <span key={item.state} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block size-2.5 rounded-sm border-2"
            style={{ borderColor: item.color }}
          />
          {item.label}
        </span>
      ))}
    </div>
  );
}
