import { IconArrowDownRight, IconArrowUpRight, IconMinus } from "@tabler/icons-react";

// ---------------------------------------------------------------------------
// Delta: "+6" / "-3" against the previous window, toned by whether the move
// is good. Up is good by default; pass `downIsGood` for numbers a lead wants
// falling (open work, stuck counts). Null = nothing to compare, rendered as
// a quiet dash so tiles keep their shape.
// ---------------------------------------------------------------------------

export interface DeltaProps {
  delta: number | null;
  /** "vs last week" — rendered dim after the number. */
  label: string;
  /** Suffix on the number: "" for counts, " pts" for percentage points. */
  unit?: string;
  downIsGood?: boolean;
}

export function Delta({ delta, label, unit = "", downIsGood = false }: DeltaProps) {
  if (delta === null) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-helios-dim">
        <IconMinus size={11} strokeWidth={1.5} aria-hidden />
        <span className="font-mono tabular-nums">—</span>
        <span>{label}</span>
      </span>
    );
  }
  const good = delta === 0 ? null : downIsGood ? delta < 0 : delta > 0;
  const tone = delta === 0 ? "text-helios-dim" : good ? "text-helios-success" : "text-helios-danger";
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "";
  const Icon = delta > 0 ? IconArrowUpRight : delta < 0 ? IconArrowDownRight : IconMinus;
  return (
    <span className="inline-flex items-center gap-1 text-[11px]">
      <span className={`inline-flex items-center gap-0.5 font-mono tabular-nums ${tone}`}>
        <Icon size={11} strokeWidth={1.75} aria-hidden />
        {sign}
        {Math.abs(delta)}
        {unit}
      </span>
      <span className="text-helios-dim">{label}</span>
    </span>
  );
}
