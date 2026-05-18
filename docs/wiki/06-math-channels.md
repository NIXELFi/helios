# Math channels

Math channels are computed channels defined by formula. They're indistinguishable from regular channels everywhere else in Helios — every picker, inspector, and widget sees them — but they recompute on every session load from your saved expressions.

Open the editor with the **ƒ Math** button in the header, or **⌘K** → "Open Math channels".

## A math channel

```typescript
{
  id: "math.power_kw",
  display_name: "Power (kW)",
  units: "kW",
  decimals: 1,
  color: "#FFC627",
  group: "Math",
  expression: "engine.rpm * imu.lat_g / 9549",
  min: 0,
  max: 200,
  warn: 150,
  alarm: 180
}
```

Saved to `localStorage` under `helios.math-channels.v1` — global, not per-session, so the same set applies to every CSV you load.

## Expression grammar

Standard math precedence, right-associative `^`, left-associative everything else:

```
expr     = ternary
ternary  = or  ( '?' expr ':' expr )?         // a ? b : c
or       = and ( '||' and )*
and      = not ( '&&' not )*
not      = '!' not | cmp
cmp      = sum ( ( '<' | '>' | '<=' | '>=' | '==' | '!=' ) sum )?
sum      = product ( ( '+' | '-' ) product )*
product  = power   ( ( '*' | '/' | '%' ) power )*
power    = unary   ( '^' power )?
unary    = '-' unary | atom
atom     = NUMBER | IDENT | '[' BRACKETED ']' | IDENT '(' args? ')' | '(' expr ')'
```

- `IDENT` allows dots: `engine.rpm`, `gps.speed`.
- `[BRACKETED]` accepts any character: `[Engine Speed]`, `[FL Shock]` — useful for IDs with spaces or punctuation.
- Comments: `// line` and `/* block */`.

## Scalar functions

All operate sample-by-sample.

| Group | Functions |
| --- | --- |
| Trig | `sin cos tan asin acos atan atan2(y,x)` |
| Power / log | `sqrt(x) pow(b,e) exp(x) log(x) log10(x) ln(x)` |
| Rounding | `floor(x) ceil(x) round(x) sign(x) abs(x)` |
| Variadic | `min(...) max(...)` |
| Constants | `pi e` |

## Time-aware vector ops

These need the full time index and run as a pre-pass into synthetic `__v0`, `__v1`, … channels:

| Op | What it does |
| --- | --- |
| `derivative(x)` | Central-difference `dx/dt`; edges = NaN |
| `integral(x)` | Cumulative trapezoidal integral; `out[0] = 0` |
| `shift(x, dtSeconds)` | Time-shift backward or forward; out-of-range = NaN |
| `smooth(x, n)` | Centered moving average; even `n` rounded up to odd; edges = NaN |
| `lowpass(x, fcHz)` | First-order IIR low-pass at cutoff `fc` |
| `highpass(x, fcHz)` | First-order IIR high-pass |
| `previous_sample(x, default)` | Lag-1 (`y[i] = x[i-1]`) |
| `time_valid(cond, holdSeconds)` | Emits 1 only after `cond` has been true continuously for `holdSeconds`. Debounces noise. |
| `edge_delay(x, rise, hold, fall)` | Custom edge detector with hysteresis. |
| `range_change(x, threshold)` | Threshold crossings. |
| `flip_flop(x, risingThresh, fallingThresh)` | Schmitt trigger (hysteretic binary). |
| `stat_min / stat_max / stat_mean / stat_std_dev / stat_start / stat_end(x, windowSeconds)` | Per-window stats. |
| `integrate_over(x, windowSeconds)` | Running integral over a sliding window. |
| `lap_min / lap_max / lap_mean / lap_first / lap_last(x)` | Per-lap aggregates (requires lap detection). |

## The editor UI

The ƒ Math modal has three columns:

1. **List** — every saved math channel, with delete + edit buttons. Red border on any that failed to compile.
2. **Editor** — id, display name, units, decimals, color, group; an expression `<textarea>` with live syntax / unknown-channel diagnostics; min/max/warn/alarm.
3. **Palette** — Channels, Operators, Functions, Time ops, Constants. **Click** any token to insert it at the textarea caret. **Drag** to insert at an exact spot.

The palette auto-wraps non-bare ids in `[…]` so `FL Shock` becomes `[FL Shock]` on insert. The id resolver is tolerant of casing and whitespace inside brackets (`[ fl  shock ]` matches `FL Shock`).

## Compile & apply

When you save a math channel, the engine:

1. Parses the expression to an AST and collects identifier references.
2. Resolves each reference to a rate group (exact match first, then case-insensitive fallback).
3. Picks the **highest-rate** referenced group as the base so no information is lost.
4. Pre-applies vector ops, building synthetic columns.
5. Evaluates the expression sample-by-sample using `evalAst` with a resolver that pulls from same-group, cross-group (resampled via binary search), and synthetic columns.
6. Adds the result to the store with your `id` and metadata. It immediately becomes visible in every picker.

Math channels recompute on every session load. Compilation errors don't block other math channels — failing entries are kept in `ApplyResult.errors: Map<string, string>` and surfaced as red borders in the editor.

**Per-session errors:** since v2.4.1 (entry 29), the error map is keyed by `(sessionId, channelId)` so an overlay with a disjoint channel set doesn't trigger a global red error indicator.

## Example expressions

| Goal | Expression |
| --- | --- |
| Throttle in % from a 0–1 channel | `engine.tps * 100` |
| Approximate power (kW) from RPM and torque | `engine.rpm * engine.torque / 9549` |
| 5 Hz low-pass on lateral G | `lowpass(imu.lat_g, 5)` |
| Lateral G smoothed and 0.2 s shifted | `shift(smooth(imu.lat_g, 11), 0.2)` |
| Combined longitudinal + lateral acceleration | `sqrt(imu.lat_g^2 + imu.long_g^2)` |
| Wheel slip ratio | `(wheel.speed_fl - vehicle.speed) / vehicle.speed` |
| Brake event valid for ≥0.5 s | `time_valid(brake.pressure_front > 5, 0.5)` |
| Per-lap mean throttle | `lap_mean(engine.tps)` |
| Gear-change events (flank detector) | `previous_sample(transmission.gear, transmission.gear) != transmission.gear ? 1 : 0` |
| First derivative of front brake pressure | `derivative(brake.pressure_front)` |

## Reference files

| File | Role |
| --- | --- |
| [`packages/lib/src/math-expr.ts`](../../packages/lib/src/math-expr.ts) | Tokenizer + parser + scalar eval. |
| [`apps/desktop/src/lib/vector-ops.ts`](../../apps/desktop/src/lib/vector-ops.ts) | Time-aware ops. |
| [`apps/desktop/src/lib/math-channels.ts`](../../apps/desktop/src/lib/math-channels.ts) | Compilation, application, persistence. |
| [`apps/desktop/src/components/MathChannelsModal.tsx`](../../apps/desktop/src/components/MathChannelsModal.tsx) | Editor UI. |
