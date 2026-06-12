/**
 * Lightweight pulse-skeleton placeholders. Layout-stable substitutes for the
 * old "Loading…" text lines so the panel doesn't jump when data lands.
 */

export function SkeletonRows({ rows = 6 }: { rows?: number }) {
  return (
    <div aria-hidden className="animate-pulse space-y-2 p-3">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <div className="h-3.5 w-3.5 rounded bg-helios-line/70" />
          <div
            className="h-3.5 rounded bg-helios-line/70"
            // Vary widths so the placeholder reads as a list, not a grid.
            style={{ width: `${[58, 42, 66, 35, 50, 44][i % 6]}%` }}
          />
          <div className="ml-auto h-4 w-16 rounded-full bg-helios-line/50" />
        </div>
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  );
}

export function SkeletonTree({ rows = 8 }: { rows?: number }) {
  return (
    <div aria-hidden className="animate-pulse space-y-2.5 p-3">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-2" style={{ paddingLeft: [0, 12, 12, 24, 0, 12, 24, 0][i % 8] }}>
          <div className="h-3 w-3 rounded-sm bg-helios-line/70" />
          <div
            className="h-3 rounded bg-helios-line/70"
            style={{ width: `${[55, 40, 62, 35, 48, 58, 30, 45][i % 8]}%` }}
          />
        </div>
      ))}
      <span className="sr-only">Loading folders…</span>
    </div>
  );
}
