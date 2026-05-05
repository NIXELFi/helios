# 08 — Multi-session overlay (phase A: panel + strip-chart overlay)

## Symptom / motivation

Helios could only display one CSV at a time. MoTeC i2's standard workflow for lap-vs-lap comparison is to load multiple sessions, leave them all in a side panel, and toggle visibility per session — visible sessions overlay on every plot in distinct colors. We want that workflow.

## Phase plan

| Phase | Scope | Status |
| - | - | - |
| **A (this commit)** | Left panel listing every loaded session, multi-load, per-session colors, **strip-chart overlay** | ✅ done |
| **B** | GPS track and XY plot overlay | future |
| **C** | "Primary session" handling for single-value widgets (gauges, readouts) | future |

## Decisions baked in

These were locked in before implementation; future work should respect them or call out a deviation.

- **Time alignment is relative.** Every CSV exported from MoTeC starts at `t = 0`, so overlays just plot each session against its own zero. There is no "absolute clock" mode yet — we'll add a toggle if a user actually needs it.
- **Single-value widgets read from the *primary* session.** Gauges, readouts, and the engine bar can't show two scalars at once, so they ignore overlays entirely and use the primary session's slice. The primary is the one highlighted in the side panel.
- **Cursor stays a single global time.** Each visible session draws its own scrub indicator at the same relative `t`. Scrubbing on a strip chart updates everything.
- **One `ChannelStore` per session.** No attempt to merge data into a single store — sessions are independent objects with their own channels and time ranges.

## What this commit ships

### Data model — [apps/desktop/src/lib/session.ts](../apps/desktop/src/lib/session.ts)

```ts
export interface LoadedSession {
  id: string;
  label: string;
  store: ChannelStore;
  color: string;
  visible: boolean;
}
```

Plus a small palette of distinct colors keyed by load order (yellow, cyan, green, red, purple, orange, light green, teal). Color is fixed at load time — sessions can't recolor without an editor.

### Loader — [apps/desktop/src/lib/load-sample.ts](../apps/desktop/src/lib/load-sample.ts)

`loadAllSessions()` loads every bundled sample in parallel and returns a `LoadedSession[]`. The first sample is `visible: true` by default; others load hidden so the overlay is opt-in.

### Widget interface — [packages/widgets/src/types.ts](../packages/widgets/src/types.ts)

`WidgetRenderProps` got a new optional field:

```ts
overlays?: OverlaySession[];   // every visible session, primary first
```

`OverlaySession` carries `{id, label, color, slice, range, isPrimary}`. Single-value widgets keep using the existing `slice` and `timeRange` (which are the primary's). Multi-trace widgets opt in by reading `overlays`.

### Tile renderer — [apps/desktop/src/components/Tile.tsx](../apps/desktop/src/components/Tile.tsx)

Now takes `primary: LoadedSession` and `visibleSessions: LoadedSession[]` instead of a single store. Builds an `overlays` array (primary first, then any other visible session that has at least one of the tile's required channels) and forwards it to the widget.

### Side panel — [apps/desktop/src/components/SessionPanel.tsx](../apps/desktop/src/components/SessionPanel.tsx)

Collapsible left rail, modeled on MoTeC i2's layout. Each row shows a checkbox (visibility toggle), a color swatch matching the trace color, and the session label. Click the row to mark a session **primary** (must be visible first). Collapse-button leaves a 32 px-wide spine with an expand chevron.

### Strip chart overlay — [packages/widgets/src/strip-chart/render.tsx](../packages/widgets/src/strip-chart/render.tsx)

The chart now builds a unified X axis from the union of all visible sessions' timestamps, then emits one uPlot series per `(session × channel)` pair. Each series is `NaN` at X values where that session has no sample, so uPlot draws gaps instead of fake interpolation. Color logic:

| Visible sessions | Channels in chart | Colors used |
| - | - | - |
| 1 | any | configured channel colors (current behavior) |
| ≥ 2 | 1 | session color, solid stroke |
| ≥ 2 | ≥ 2 | session color + dash pattern by channel index |

This matches the MoTeC convention: when comparing laps, **session is the dominant visual signal, channel is secondary**.

### App.tsx

The sample `<select>` is gone. The primary session's label is shown in the header (next to HELIOS) as the source-of-truth indicator. The cursor emitter is preserved across primary changes; single-value widgets simply read from the new primary's store on next render.

## Performance notes

- The X-union build runs once on mount and on `slice` / `config` / visible-session-set changes. The cursor scrub does **not** rebuild data — only the yellow line moves.
- Worst case so far: 1000 Hz file (34 k samples) overlaid with 100 Hz file (4 k samples) = ~38 k unified X values × N series. uPlot handles tens of thousands of points fine on canvas; drag stays smooth.
- The unified-X approach trades memory for simplicity. Per-series Float64Array is `8 × len(union)` bytes; for the worst case above that's ~300 KB per series. Acceptable.

## Files changed

- [apps/desktop/src/lib/session.ts](../apps/desktop/src/lib/session.ts) — new
- [apps/desktop/src/lib/load-sample.ts](../apps/desktop/src/lib/load-sample.ts) — added `loadAllSessions`
- [apps/desktop/src/components/SessionPanel.tsx](../apps/desktop/src/components/SessionPanel.tsx) — new
- [apps/desktop/src/components/Tile.tsx](../apps/desktop/src/components/Tile.tsx) — multi-session signature
- [apps/desktop/src/App.tsx](../apps/desktop/src/App.tsx) — drove the new state model
- [packages/widgets/src/types.ts](../packages/widgets/src/types.ts) — `OverlaySession` + `overlays` prop
- [packages/widgets/src/strip-chart/render.tsx](../packages/widgets/src/strip-chart/render.tsx) — overlay rendering
