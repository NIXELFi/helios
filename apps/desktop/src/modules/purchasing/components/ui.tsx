import type { ReactNode } from "react";
import { STATUS_LABEL, type Priority, type Status, type Subteam } from "../lib/api";

const STATUS_STYLE: Record<Status, string> = {
  PLANNED: "bg-helios-strip text-helios-dim border-helios-line",
  READY: "bg-helios-info/15 text-helios-info border-transparent",
  APPROVED: "bg-asu-gold/15 text-asu-gold border-transparent",
  ORDERED: "bg-violet-500/15 text-violet-300 border-transparent",
  BACKORDERED: "bg-violet-500/15 text-violet-300 border-transparent",
  SHIPPED: "bg-sky-500/15 text-sky-300 border-transparent",
  DELIVERED: "bg-sky-500/15 text-sky-300 border-transparent",
  RECEIVED: "bg-helios-success/15 text-helios-success border-transparent",
  RECONCILED: "bg-helios-success/15 text-helios-success border-transparent",
  DENIED: "bg-helios-danger/15 text-helios-danger border-transparent",
  CANCELLED: "bg-transparent text-helios-muted border-helios-line",
  HAVE: "bg-transparent text-helios-muted border-helios-line",
};

const PRIORITY_STYLE: Record<Priority, string> = {
  HIGH: "bg-asu-gold text-helios-on-gold border-transparent",
  Medium: "bg-blue-600 text-white border-transparent",
  Low: "bg-helios-strip text-helios-dim border-helios-line",
};

const pill = "rounded-md border px-2 py-0.5 text-xs font-semibold";

export function StatusPill({ status }: { status: Status }) {
  return <span className={`${pill} whitespace-nowrap ${STATUS_STYLE[status]}`}>{STATUS_LABEL[status]}</span>;
}

export function StatusSelect({
  status, options, onChange,
}: { status: Status; options: Status[]; onChange: (s: Status) => void }) {
  if (options.length <= 1) return <StatusPill status={status} />;
  return (
    <select
      aria-label="Status"
      className={`${pill} cursor-pointer ${STATUS_STYLE[status]}`}
      value={status}
      onChange={(e) => onChange(e.target.value as Status)}
    >
      {options.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
    </select>
  );
}

export function PrioritySelect({
  priority, editable, onChange,
}: { priority: Priority; editable: boolean; onChange: (p: Priority) => void }) {
  if (!editable) return <span className={`${pill} ${PRIORITY_STYLE[priority]}`}>{priority}</span>;
  return (
    <select
      aria-label="Priority"
      className={`${pill} cursor-pointer ${PRIORITY_STYLE[priority]}`}
      value={priority}
      onChange={(e) => onChange(e.target.value as Priority)}
    >
      {(["HIGH", "Medium", "Low"] as Priority[]).map((p) => <option key={p}>{p}</option>)}
    </select>
  );
}

export function SubteamChip({ subteam }: { subteam: Subteam | undefined }) {
  if (!subteam) return <span className="text-xs text-helios-muted">no subteam</span>;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-helios-line bg-helios-strip px-2 py-0.5 text-[11px] font-bold tracking-wide">
      <span className="size-1.5 rounded-full" style={{ background: subteam.color ?? "#8d8d97" }} />
      {subteam.code}
    </span>
  );
}

export function Button({
  children, onClick, kind = "primary", disabled, title, type = "button",
}: {
  children: ReactNode; onClick?: () => void; kind?: "primary" | "ghost" | "danger" | "good";
  disabled?: boolean; title?: string; type?: "button" | "submit";
}) {
  const style = {
    primary: "bg-asu-gold text-helios-on-gold border-asu-gold hover:brightness-110",
    ghost: "bg-transparent text-helios-text border-helios-line hover:bg-helios-strip",
    danger: "bg-transparent text-helios-danger border-helios-danger/40 hover:bg-helios-danger/10",
    good: "bg-helios-success text-black border-helios-success hover:brightness-110",
  }[kind];
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`rounded-md border px-3 py-1.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${style}`}
    >
      {children}
    </button>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-lg border border-helios-line bg-helios-panel p-4 ${className}`}>{children}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-helios-line p-8 text-center text-sm text-helios-muted">{children}</div>;
}

/** A small "saved" / error line under a view's header. */
export function Flash({ message, error }: { message: string | null; error?: boolean }) {
  if (!message) return null;
  return (
    <div className={`mb-3 rounded-md border px-3 py-2 text-sm ${error
      ? "border-helios-danger/40 bg-helios-danger/10 text-helios-danger"
      : "border-helios-success/40 bg-helios-success/10 text-helios-success"}`}>
      {message}
    </div>
  );
}
