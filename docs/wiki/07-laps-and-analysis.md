# Laps & analysis

Helios models laps as first-class entities — detected per session, selectable globally, and consumed by every analysis widget.

## Lap detection modes

Per-session, configured in the **Lap Config** dialog (sidebar → expand session → "Configure lap detection…").

| Mode | What it does | Config |
| --- | --- | --- |
| `none` | No laps. Most widgets that need laps will show a "no laps" message. | — |
| `gps_line` | Trigger on crossing a GPS start/finish line. | `latChannelId`, `lonChannelId`, `centerLat`, `centerLon`, `radiusM` (≈30 m for cars), optional `headingDeg` to filter by direction. |
| `beacon` | Rising edge of a beacon channel above a threshold. | `channelId`, `threshold` |
| `expression` | Rising edge of a math expression returning truthy. | `expression` (any math-expr). |
| `manual` | User-entered crossing timestamps. | `crossingsUs[]` |

**Picking a GPS start/finish:** in `gps_line` mode the dialog has a *"Click to pick start/finish"* button that arms the GPS Track widget. The dialog collapses to a non-blocking banner; the next click on the map sets the coordinates and reopens the dialog.

Config persists in `localStorage` under `helios.lap-config.v1.<sessionId>`. Session id is `user:` + djb2 hash of the absolute path, so the same file always restores the same lap config — even across app restarts.

## Lap data

Each detected lap is:

```typescript
{
  index: number,        // 0 = out-lap, 1..N = trusted, last = in-lap
  startUs: number,
  endUs: number,
  durationS: number,
  distanceM: number,    // cumulative integral of a speed channel; NaN if none
  trusted: boolean,
  note?: string
}
```

The detector emits a `LapSet` with `laps[]` plus a `bestLapIndex` (lowest `durationS` among trusted laps).

## Lap selection (Main / Ref / Overlay)

Selection is **global** — the `LapSelectionEmitter` in `App.tsx` carries:

```typescript
{
  main?:     { sessionId, lapIndex },
  ref?:      { sessionId, lapIndex },
  overlays:  { sessionId, lapIndex }[]
}
```

Three ways to select:

| Action | Target |
| --- | --- |
| Plain click on lap row, **M** button, or palette "Set lap N as Main" | Main |
| ⌘/Ctrl-click row, **R** button, or palette "Set lap N as Ref" | Ref |
| Shift-click row, **O** button | Toggle Overlay |

**Auto-pick on session load:** if nothing is saved, Helios chooses the best lap as Main and the second-best as Ref.

**Persistence:** the entire selection saves to `app-state.v1` debounced at 400 ms. On restart, references are validated against currently-loaded sessions — stale ids drop silently.

**Palette quick actions:** ⌘K offers `"Set best lap as Main"`, `"Set 2nd-best lap as Ref"`, `"Swap Main and Ref"`, `"Clear Ref lap (hide Δt)"`.

## Distance mode

Several widgets can render against per-lap projected distance instead of elapsed time:

- **Strip Chart** — `xMode: "distance"`. Renders only Main, Ref, and Overlay laps, aligned by distance.
- **Lap Delta** — distance-only by design.
- **Sector Table** — distance-only.

Distance is computed as the cumulative integral of a speed channel (`gps.speed`, `vehicle.speed`, `wheel.speed_avg`, or `engine.wheel_speed_avg`), with units auto-converted to meters via the channel metadata.

## Lap-aware widgets

| Widget | What you get | See |
| --- | --- | --- |
| **Lap Panel** | Sortable lap list with click-to-select. | [Widgets](04-widgets-reference.md#lap-panel) |
| **Lap Delta** | Δt(distance) between Main and Ref, green/red colored. | [Widgets](04-widgets-reference.md#lap-delta) |
| **Sector Table** | Equal-distance sector splits per lap; per-sector and overall best highlighted. | [Widgets](04-widgets-reference.md#sector-table) |
| **Time Report** | Best, mean, median, std-dev, consistency %, rolling-N best. | [Widgets](04-widgets-reference.md#time-report) |
| **Channel Report** | Per-lap × per-channel stats (avg, min, max, abs-max, start, end, change, σ). | [Widgets](04-widgets-reference.md#channel-report) |
| **Zone Stats** | Stats inside a datum-defined zone (datum-to-datum or datum-to-cursor). | [Widgets](04-widgets-reference.md#zone-stats) |

## Footer lap-compare strip

When **both** Main and Ref laps are set, the footer adds:

```
… · Main M:SS.cc · Ref M:SS.cc · Δ ±S.cc …
```

The Δ is colored:

- **Green** #66BB6A — Main is faster (Δ < −5 ms)
- **Red** #EF5350 — Main is slower (Δ > +5 ms)
- **Gray** #D8DCE2 — within ±5 ms

Format: `SS.CCs` under a minute, `M:SS.CC` over a minute, `—` if not yet computed.

## Hotkeys

| Key | Action |
| --- | --- |
| `[` | Jump cursor to start of previous lap (primary session) |
| `]` | Jump cursor to start of next lap (primary session) |
| `M` | Set lap containing cursor as Main |
| `R` | Set lap containing cursor as Ref |

All four ignore text inputs.

## Reference files

| File | Role |
| --- | --- |
| [`packages/lib/src/laps.ts`](../../packages/lib/src/laps.ts) | Detection modes, lap segmentation, distance integration. |
| [`apps/desktop/src/components/LapConfigDialog.tsx`](../../apps/desktop/src/components/LapConfigDialog.tsx) | Per-session detection UI. |
| [`apps/desktop/src/lib/lap-config.ts`](../../apps/desktop/src/lib/lap-config.ts) | Persistence. |
| [`apps/desktop/src/App.tsx`](../../apps/desktop/src/App.tsx) | LapSelectionEmitter + global wiring (see line ~76). |
