import type { ReactNode } from "react";

/** Panel wrapper shared by every Insights chart — consistent border / padding /
 *  title treatment so the dashboard reads as one grid. */
export function ChartCard({
  title,
  subtitle,
  right,
  children,
  className = "",
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={"flex flex-col rounded-lg border border-helios-line bg-helios-panel p-4 " + className}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-helios-text">{title}</h3>
          {subtitle ? <p className="mt-0.5 text-xs text-helios-dim">{subtitle}</p> : null}
        </div>
        {right}
      </div>
      <div className="flex-1">{children}</div>
    </div>
  );
}

/** Headline KPI tile. `value` is pre-formatted by the caller. */
export function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-helios-line bg-helios-panel px-4 py-3">
      <div className="font-mono-num text-2xl font-semibold tabular-nums text-helios-text">{value}</div>
      <div className="mt-0.5 text-[10px] font-medium uppercase tracking-widest text-helios-dim">{label}</div>
      {hint ? <div className="mt-0.5 text-[11px] text-helios-dim/80">{hint}</div> : null}
    </div>
  );
}

/** Centered empty/zero state for a chart with no data. */
export function EmptyChart({ message = "No data" }: { message?: string }) {
  return (
    <div className="flex h-full min-h-[120px] items-center justify-center text-xs text-helios-dim">
      {message}
    </div>
  );
}
