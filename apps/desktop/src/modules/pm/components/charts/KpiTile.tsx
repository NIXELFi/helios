"use client";

import type { ReactNode } from "react";
import { IconArrowRight } from "@tabler/icons-react";
import { Link } from "@pm/lib/router";

// ---------------------------------------------------------------------------
// KpiTile: one headline number, a one-line qualifier, a Delta and an optional
// mini chart. The WHOLE tile is a link into the Table with the matching
// filters, so every number on the Productivity page has a verb attached.
// ---------------------------------------------------------------------------

export interface KpiTileProps {
  label: string;
  value: string | number;
  /** One line under the value: "9 unowned · 3 overdue". */
  sub?: ReactNode;
  /** Usually a <Delta/>. */
  compare?: ReactNode;
  /** Usually a <Sparkline/> or a <DayStrip/>. */
  chart?: ReactNode;
  href: string;
  /** "Open completed tasks in the Table" — read by screen readers on the link. */
  linkLabel: string;
  tone?: "neutral" | "warn" | "danger";
}

const VALUE_TONE: Record<NonNullable<KpiTileProps["tone"]>, string> = {
  neutral: "text-helios-text",
  warn: "text-helios-warn",
  danger: "text-helios-danger",
};

export function KpiTile({ label, value, sub, compare, chart, href, linkLabel, tone = "neutral" }: KpiTileProps) {
  return (
    <Link
      href={href}
      aria-label={linkLabel}
      className="group flex min-w-0 flex-col gap-1.5 rounded-md border border-helios-line bg-helios-panel p-4 transition-colors hover:border-helios-text/30 focus:outline-none focus-visible:border-asu-gold"
    >
      <span className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-widest text-helios-dim">{label}</span>
        <IconArrowRight
          size={13}
          strokeWidth={1.5}
          aria-hidden
          className="text-helios-dim opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        />
      </span>
      <span className="flex items-end justify-between gap-3">
        <span className={`font-mono text-3xl font-semibold leading-none tabular-nums ${VALUE_TONE[tone]}`}>
          {value}
        </span>
        {chart ? <span className="shrink-0 pb-0.5">{chart}</span> : null}
      </span>
      {sub ? <span className="truncate text-[11px] text-helios-dim">{sub}</span> : null}
      {compare ? <span className="mt-0.5">{compare}</span> : null}
    </Link>
  );
}
