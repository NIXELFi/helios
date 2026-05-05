# 15 — Math channels (phase A)

## Symptom / motivation

The team needs MoTeC-style **math channels** — derived channels defined by formula that show up alongside real channels in every widget. This commit lands phase A: the engine, storage, application, and a UI to manage them. Time-based ops (derivatives, integrals, smoothing) and per-lap aggregates are deferred to phase B.

## What this commit ships

### Expression engine — [packages/lib/src/math-expr.ts](../packages/lib/src/math-expr.ts)

Hand-rolled tokenizer + recursive-descent parser → AST + tree-walking evaluator. No external dependency.

**Supported syntax:**
- Numbers (`42`, `3.14`, `1e-3`)
- Identifiers — bare like `engine.rpm` (letters/digits/underscore/dot) or bracketed like `[Engine Speed]` for names with spaces
- Operators (precedence low → high): `||`, `&&`, `!`, `< > <= >= == !=`, `+ -`, `* / %`, `^` (right-assoc), unary `-`
- Ternary `cond ? a : b`
- Functions: `abs sqrt sin cos tan asin acos atan atan2 min max pow exp log log10 ln floor ceil round sign`
- Constants: `pi`, `e`

**Boolean semantics:** any non-zero is truthy; comparisons and logical ops emit `0` or `1`. Unknown identifiers evaluate to `NaN` (so a single bad sample doesn't kill the whole channel).

**14 unit tests** in [packages/lib/tests/math-expr.test.ts](../packages/lib/tests/math-expr.test.ts) cover precedence, ternary, functions, identifier resolution, error reporting, and a real-world MoTeC-style power formula (`rpm * torque / 9549`).

### Storage — [apps/desktop/src/lib/math-channels.ts](../apps/desktop/src/lib/math-channels.ts)

```ts
export interface MathChannel {
  id: string;          // canonical id, e.g. "math.power"
  display_name: string;
  units: string;
  decimals: number;
  color: string;
  group: string;
  expression: string;
  min?: number; max?: number; warn?: number; alarm?: number;
}
```

Persisted to `localStorage` under `helios.math-channels.v1` (versioned envelope, ready for future migrations). **Global, not per-workspace** — the same set of math channels is applied to every loaded session, just like MoTeC's project-level math.

### `applyMathChannels(store, channels)` — same file

For each math channel:

1. Parse the expression into an AST.
2. Collect referenced identifiers and look up their rate group via `store.groupOf(ref)`.
3. Pick the **highest-rate** dependency's rate group as the time base, so we don't lose information.
4. Evaluate per-sample. Same-group dependencies are read directly via column index; cross-rate-group deps are sampled via binary search on their group's time array.
5. Add the result as a real channel via the new `ChannelStore.addChannel(groupId, meta, values)`.

Math channels with parse or apply errors are skipped — the function returns a `Map<id, message>` so the UI can flag them. Other math channels still apply.

Math channels evaluate in **declaration order**, so a math channel may reference an earlier math channel.

### `ChannelStore` extensions — [packages/store/src/channel-store.ts](../packages/store/src/channel-store.ts)

```ts
groupOf(channelId: string): RateGroup | undefined;
addChannel(groupId: string, meta: ChannelMeta, values: Float64Array): void;
removeChannel(channelId: string): void;
```

Rate-group columns are mutable maps so `addChannel` is just an `rg.columns.set(...)` plus updating the meta tables. `removeChannel` cleans up so a renamed/deleted math channel doesn't leave a stale column behind.

### UI — [apps/desktop/src/components/MathChannelsModal.tsx](../apps/desktop/src/components/MathChannelsModal.tsx)

A new "ƒ Math" button in the header (between Channels and Edit) opens a modal:

- **Left:** sortable list of math channels with color swatch, id, display name, and a red `!` for any with a current apply error.
- **Right:** editor for the selected channel — id, display name, units, decimals, color, group, **expression textarea** with live syntax checking, and min/max/warn/alarm.
- The expression box turns red on parse error and shows the message inline. If the expression is valid but references unknown channels (in the primary session), an amber warning lists them.
- Footer surfaces every available built-in (`pi e`, `abs sqrt sin cos …`).
- Auto-save on every keystroke; new channels seed via "+ add"; "Delete" confirms first.

### Wiring — [apps/desktop/src/App.tsx](../apps/desktop/src/App.tsx)

- Math channels load from storage at boot.
- After every session loads, math channels are applied to **each** session's store.
- When the user changes math channels in the modal, the old set's ids are removed from every session's store first (handles renames + deletes), then the new set is re-applied.
- Apply errors are surfaced two ways: the header button turns red with a tooltip ("N math channel(s) failed to compile"), and the modal shows them inline next to the offending channel.
- Math channels appear in `store.list()` like any channel, so they are immediately:
  - Visible in the **Channels inspector** modal.
  - Available in every widget's **ChannelPicker** dropdown (under their `group`, default "Math").
  - Plottable / scrubable / overlayable across sessions.

## Example formulas

The team can paste these into the modal to get going:

| Display name | Expression |
| - | - |
| Power (kW) | `engine.rpm * 0.1047` (assuming engine.rpm × 2π/60 — placeholder; needs torque too) |
| RPM × 2 | `engine.rpm * 2` |
| Combined Gs | `sqrt(imu.lat_g^2 + imu.lat_g^2)` |
| In-corner flag | `abs(imu.lat_g) > 1` |

## Decisions

- **Global, not per-workspace.** A math channel is conceptually a property of the data model, not the layout. If two workspaces want different math, that's a phase-B feature.
- **Highest-rate dep wins.** Math channel lives in the highest-rate dependency's rate group. Lower-rate deps are sampled via binary search.
- **Unknown identifier = NaN.** Lets you prototype formulas against sessions that don't have every dependency without crashing the channel.
- **No collision with real channels.** Math channels with the same id as an existing channel will overwrite it (same as `addChannel` semantics). The UI doesn't currently check for collisions; consider adding a guard if this becomes an issue.

## What's NOT in this commit (phase B+)

- Time ops: `derivative(x)`, `integral(x)`, `shift(x, dt)`
- Smoothing: `smooth(x, n)`, `lowpass(x, fc)`
- Per-lap aggregates: `lap_max(x)`, `lap_min(x)`, `lap_mean(x)`
- Channel autocomplete in the formula textarea
- Import/export math channel sets
- Graphical formula builder

## Files changed

- [packages/lib/src/math-expr.ts](../packages/lib/src/math-expr.ts) — new
- [packages/lib/src/index.ts](../packages/lib/src/index.ts) — re-export
- [packages/lib/tests/math-expr.test.ts](../packages/lib/tests/math-expr.test.ts) — new
- [packages/store/src/channel-store.ts](../packages/store/src/channel-store.ts) — `groupOf`, `addChannel`, `removeChannel`
- [apps/desktop/src/lib/math-channels.ts](../apps/desktop/src/lib/math-channels.ts) — new
- [apps/desktop/src/components/MathChannelsModal.tsx](../apps/desktop/src/components/MathChannelsModal.tsx) — new
- [apps/desktop/src/App.tsx](../apps/desktop/src/App.tsx) — header button + apply wiring
