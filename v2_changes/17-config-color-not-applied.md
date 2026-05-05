# 17 — Config panel edits not persisting to the rendered widget

## Symptom

Two related bugs shared this entry:

1. **Color edits ignored.** In edit mode, changing a tile's color in the config panel had no effect on the rendered widget. Affected histogram and xy-plot. GPS had a related but different issue — no `color` field at all in `GpsTrackConfig` so nothing to edit.
2. **Field reverts instantly.** Changing a dropdown like GPS's `colorByChannelId` would briefly show the new value then snap back. Caused by a stale-closure bug in App's tile-update path.

## Root cause

Phase B's multi-session overlay refactor ([10](10-multi-session-overlay-phase-b.md)) unified every multi-trace widget around a `visible: OverlaySession[]` array, with each entry carrying a `color` field that comes from the **session palette** (`LoadedSession.color`, assigned by load order). When the app passes a real `overlays` prop — which it always does — the synthetic single-session fallback never fires, so the renderers were always reading the palette color via `overlays[0].color` even when only one session was visible.

The user-configured `config.color` was being set correctly into state and persisted to localStorage, but the renderers ignored it.

In histogram:

```ts
// before
ctx.fillStyle = datasets[0]!.session.color;  // always the palette, never config.color
```

In xy-plot:

```ts
// before
ctx.fillStyle = sl.session.color;  // ignored config.color in the non-trail single-session branch
```

GPS-track was using `p.session.color` as well; it never had a config.color to fall back to.

## Fix

Three small changes; all keep the multi-session-uses-palette behavior intact.

### Histogram — [packages/widgets/src/histogram/render.tsx](../packages/widgets/src/histogram/render.tsx)

Single-session draw now reads `config.color`:

```ts
ctx.fillStyle = config.color;  // single session: editable in the panel
```

Multi-session keeps the per-session outline + light fill (palette colors), unchanged.

### XY plot — [packages/widgets/src/xy-plot/render.tsx](../packages/widgets/src/xy-plot/render.tsx)

Color rule made explicit:

```ts
//   single session, trail=true  → time-coloured gradient
//   single session, trail=false → configured color (editable in the panel)
//   multi session               → session palette color, one per overlay
ctx.fillStyle = isMulti ? sl.session.color : config.color;
```

### GPS track — [packages/widgets/src/gps-track/render.tsx](../packages/widgets/src/gps-track/render.tsx) + [config-editor.tsx](../packages/widgets/src/gps-track/config-editor.tsx)

`GpsTrackConfig` got an optional `color?: string` field. The line stroke and the cursor dot now use:

```ts
!isMulti && config.color ? config.color : p.session.color
```

so the configured color wins in single-session mode and the palette wins in multi-session mode. Color is also ignored when `colorByChannelId` is set, since the gradient mode takes over.

The config editor gained a `color` color-picker row alongside the existing fields. Default is `#4FC3F7` (the v1 hardcoded GPS line color) so existing tiles look unchanged until edited.

## The actual cause of the "edits revert visually" symptom — stale `draw` closure in every canvas widget

After the first round of fixes the user reported the symptom still happened on GPS: the dropdown stayed correct, the persisted JSON showed the new value, but the **canvas itself** repainted with the old config a moment later. So state was right; rendering was wrong.

Every canvas widget had the same shape of bug:

```ts
// gps-track / xy-plot / histogram / bar-gauge / round-gauge / engine-bar
const onResize = useCallback(() => { draw(); }, []);   // ← captures FIRST render's `draw`
useResizeObserver(canvasRef, onResize);
```

`useCallback` with empty deps captures `draw` from the very first render forever. Every later render redefines `draw` with the new `config` closure, but `onResize` keeps a reference to the original. When the `ResizeObserver` fires (which it does on layout flushes triggered by React reconciliation, even when the canvas size hasn't truly changed), it invokes the **old** `draw` — which closes over **old** config — and the canvas repaints with the original colors a moment after the user's edit.

GPS specifically also had its cursor subscription captured `draw` from first render via `[cursorEmitter]`-only deps, so any cursor scrub during edit mode would have done the same thing.

### Fix — `drawRef` pattern

Each canvas widget gained a ref that's reassigned on every render, so long-lived callbacks always invoke the latest `draw`:

```ts
const drawRef = useRef<() => void>(() => {});
drawRef.current = draw;  // synchronous reassignment every render

const onResize = useCallback(() => { drawRef.current(); }, []);
useResizeObserver(canvasRef, onResize);

// (cursor subscription, where applicable, also reads drawRef.current())
```

`drawRef.current` is updated synchronously during render (refs are allowed to mutate during render in React), so by the time any committed effect or DOM callback fires, the ref already points at the latest closure. The `useResizeObserver` registration stays stable (no observer churn), and the same trick is applied to the cursor subscription in widgets where the deps weren't already config-aware (gps-track most importantly).

Applied across: [bar-gauge](../packages/widgets/src/bar-gauge/render.tsx), [engine-bar](../packages/widgets/src/engine-bar/render.tsx), [gps-track](../packages/widgets/src/gps-track/render.tsx), [histogram](../packages/widgets/src/histogram/render.tsx), [round-gauge](../packages/widgets/src/round-gauge/render.tsx), [xy-plot](../packages/widgets/src/xy-plot/render.tsx).

## Stale closure in `commitWorkspaces` — [apps/desktop/src/App.tsx](../apps/desktop/src/App.tsx)

While debugging the rendering bug above I also tightened `commitWorkspaces`. Previously:

```ts
// before — non-functional setState
function commitWorkspaces(next: Workspace[]) {
  saveWorkspaces(next);
  setWorkspaces(next);
}

function updateTile(nextTile: TileSpec) {
  commitWorkspaces(workspaces.map(...));   // ← reads `workspaces` from closure
}
```

`workspaces` is captured from the render where `updateTile` was created. If two updates land in quick succession (e.g. the user rapidly clicks a `<select>` option which fires both `change` and a sibling event), the second update's map runs against the **stale** workspaces from before the first update committed — and writes a result that overwrites the first edit. Visually: the field appears to revert.

Switched every workspace mutation to the functional setState form so they always read the latest committed state:

```ts
function commitWorkspaces(updater: (prev: Workspace[]) => Workspace[]) {
  setWorkspaces((prev) => {
    const next = updater(prev);
    saveWorkspaces(next);
    return next;
  });
}

function updateTile(nextTile: TileSpec) {
  commitWorkspaces((prev) => prev.map(...));
}
```

`updateTile`, `deleteTile`, `duplicateTile`, `handleAddTile`, and `handleSnapToGrid` all use the new pattern.

## Files changed

- [packages/widgets/src/histogram/render.tsx](../packages/widgets/src/histogram/render.tsx)
- [packages/widgets/src/xy-plot/render.tsx](../packages/widgets/src/xy-plot/render.tsx)
- [packages/widgets/src/gps-track/render.tsx](../packages/widgets/src/gps-track/render.tsx)
- [packages/widgets/src/gps-track/config-editor.tsx](../packages/widgets/src/gps-track/config-editor.tsx)
- [apps/desktop/src/App.tsx](../apps/desktop/src/App.tsx) — functional setState in every workspace mutator
