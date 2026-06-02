"use client";

import type { TaskRow, TaskStatus } from "@helios/pm-ui";
import { TypeBadge } from "@helios/pm-ui";
import { IconExternalLink } from "@tabler/icons-react";
import { differenceInCalendarDays, parseISO } from "date-fns";
import { useEffect, useRef } from "react";

const STATUS_DOT: Record<TaskStatus, string> = {
  backlog: "#9097A0",
  designing: "#60A5FA",
  manufacturing: "#FBBF24",
  testing: "#A78BFA",
  needs_review: "#FFC627",
  blocked: "#F87171",
  done: "#34D399",
};

const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: "Backlog",
  designing: "Designing",
  manufacturing: "Manufacturing",
  testing: "Testing",
  needs_review: "Needs review",
  blocked: "Blocked",
  done: "Done",
};

const CARD_W = 240;

export interface TaskPeekCardProps {
  task: TaskRow;
  x: number;
  y: number;
  onClose: () => void;
  onOpenEditor: () => void;
}

export function TaskPeekCard({ task, x, y, onClose, onOpenEditor }: TaskPeekCardProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Clamp within viewport
  const left = Math.min(x, (typeof window !== "undefined" ? window.innerWidth : 1280) - CARD_W - 12);
  const top = Math.min(y, (typeof window !== "undefined" ? window.innerHeight : 800) - 220);

  const days =
    task.due_date != null
      ? differenceInCalendarDays(parseISO(task.due_date), new Date())
      : null;

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={`${task.title} details`}
      className="fixed z-50 flex flex-col gap-2 rounded-md border border-helios-line bg-helios-panel p-3 shadow-lg"
      style={{ left: Math.max(12, left), top: Math.max(12, top), width: CARD_W }}
    >
      <div
        className="flex items-start gap-2 border-l-[3px] pl-2"
        style={{ borderLeftColor: task.subteam.color ?? "#6B7280" }}
      >
        <p className="text-sm font-medium leading-snug text-helios-text">{task.title}</p>
      </div>

      <dl className="flex flex-col gap-1.5 text-[11px]">
        <PeekRow label="Subteam">
          <span className="inline-flex items-center gap-1.5 text-helios-text">
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: task.subteam.color ?? "#6B7280" }}
            />
            {task.subteam.name}
          </span>
        </PeekRow>
        <PeekRow label="Owner">
          <span className="text-helios-text">{task.owner?.name ?? "Unassigned"}</span>
        </PeekRow>
        <PeekRow label="Type">
          <TypeBadge type={task.type} />
        </PeekRow>
        <PeekRow label="Status">
          <span className="inline-flex items-center gap-1.5 text-helios-text">
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: STATUS_DOT[task.status] }}
            />
            {STATUS_LABEL[task.status]}
          </span>
        </PeekRow>
        <PeekRow label="Days to done">
          <span className="tabular-nums text-helios-text">
            {days == null
              ? "No due date"
              : days < 0
                ? `${Math.abs(days)} overdue`
                : days === 0
                  ? "Due today"
                  : `${days} day${days === 1 ? "" : "s"}`}
          </span>
        </PeekRow>
      </dl>

      <button
        type="button"
        onClick={onOpenEditor}
        className="mt-1 inline-flex items-center justify-center gap-1.5 rounded border border-helios-line bg-helios-base px-2 py-1.5 text-xs font-normal text-helios-text hover:border-asu-gold hover:text-asu-gold"
      >
        <IconExternalLink size={13} strokeWidth={1.5} />
        Open editor
      </button>
    </div>
  );
}

function PeekRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-[10px] font-medium uppercase tracking-widest text-helios-dim">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}
