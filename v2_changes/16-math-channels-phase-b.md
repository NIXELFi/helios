# 16 — Math channels phase B: time ops + drag-and-drop palette

Builds on [15](15-math-channels-phase-a.md). The phase A formula box was capable but not very discoverable; the team also asked for the time-aware operations they'd expect from MoTeC.

## What this commit ships

### Vector (time-aware) functions — [apps/desktop/src/lib/vector-ops.ts](../apps/desktop/src/lib/vector-ops.ts)

Pure functions over `Float64Array` + the rate group's `BigInt64Array` time index. Each returns a same-length array. Edge samples are NaN where defined values can't be computed (windowed ops, shifted-out-of-range), so widgets render gaps rather than fake numbers.

| Function | Signature | Notes |
| - | - | - |
| `derivative(x)` | inputs-per-second | central difference; forward/backward at edges |
| `integral(x)` | cumulative ∫ x dt | trapezoidal, output[0] = 0 |
| `shift(x, dt)` | shifted by `dt` seconds | NaN where source time is outside the array |
| `smooth(x, n)` | centered moving avg over `n` samples | even `n` floored to next odd; NaN at edges |
| `lowpass(x, fc)` | first-order IIR LPF at `fc` Hz | uses the rate group's `nominalRateHz` |

12 unit tests in [apps/desktop/tests/vector-ops.test.ts](../apps/desktop/tests/vector-ops.test.ts) cover linear-ramp derivatives, trapezoid integrals, shift edges, even-window flooring, and step-input lowpass response.

### Lap aggregates surface as clear errors

`lap_max`, `lap_min`, `lap_mean`, `lap_first`, `lap_last` are recognized in the parser/preprocess pass but currently throw:

```
lap_max() needs lap detection, which is not implemented yet
```

This is intentional — the symbol is reserved so users can see "yes, this exists" in the palette without us silently returning NaN. Real lap aggregates land when lap detection does.

### Apply pre-pass — [apps/desktop/src/lib/math-channels.ts](../apps/desktop/src/lib/math-channels.ts)

The phase A applier was strictly point-wise. Phase B introduces a recursive AST walk that:

1. Finds every call to a vector op.
2. Recursively pre-processes its argument (so `derivative(smooth(x, 5))` works).
3. Evaluates the inner expression as a `Float64Array` against the base rate group's time.
4. Applies the vector op.
5. Stashes the result under a synthetic name (`__v0`, `__v1`, …).
6. Replaces the call node in the AST with an `ident` referencing the synthetic.

The remaining (now point-wise) AST is evaluated per-sample as before, with synthetic channels resolving from the same map as same-rate-group dependencies. Constant-only second args (`shift(x, 0.25)`, `smooth(x, 21)`, `lowpass(x, 5)`) are evaluated once at compile time.

### Token palette — [apps/desktop/src/components/MathChannelsModal.tsx](../apps/desktop/src/components/MathChannelsModal.tsx)

A new third column in the modal — between the channel list and the editor — listing every available token in collapsible categories:

- **Channels** — every channel in the primary session, grouped by `ChannelMeta.group` (Engine, GPS, IMU, Math, …) with a color swatch and the display name as a tooltip.
- **Operators** — `+ - * / % ^ ( ) , < > <= >= == != && || ! ?:` as chip buttons.
- **Functions** — every scalar function with hint text (`sin`: "x in radians", `pow`: "pow(b, e)", etc.).
- **Time ops** — `derivative integral shift smooth lowpass` with their signatures (`shift(x, dt)`, `smooth(x, n)`, …) and what they do.
- **Constants** — `pi`, `e`.

Two ways to insert:

- **Click** — inserts at the textarea's caret (or replaces the current selection).
- **Drag** — every token is `draggable` and emits `text/plain`; native browser behavior drops the text wherever the user releases the pointer inside the textarea.

A typical workflow: pick "engine.rpm" from the Channels section → click `derivative(…)` from Time ops → cursor lands inside `derivative(`, insert `engine.rpm`, type `)`. No need to remember canonical ids or function names.

### Other touches

- Footer hint updated to: *"Drag tokens from the palette into the expression box, or click them to insert at the cursor."*
- Modal grew from 880×640 to 1180×720 to fit the third column comfortably.
- Empty-state text in the channel list is more concise.

## Example formulas users can paste

| Channel | Expression |
| - | - |
| Lateral G rate of change | `derivative(imu.lat_g)` |
| RPM smoothed (~10 Hz) | `lowpass(engine.rpm, 10)` |
| Distance from speed | `integral(gps.speed)` |
| 50 ms anticipation | `shift(engine.rpm, 0.05)` |
| Coast detector | `(engine.tps < 5) && (engine.rpm > 4000) ? 1 : 0` |
| Smoothed combined Gs | `sqrt(smooth(imu.lat_g, 21)^2 + smooth(imu.lat_g, 21)^2)` |

## Files changed

- [apps/desktop/src/lib/vector-ops.ts](../apps/desktop/src/lib/vector-ops.ts) — new
- [apps/desktop/tests/vector-ops.test.ts](../apps/desktop/tests/vector-ops.test.ts) — new
- [apps/desktop/src/lib/math-channels.ts](../apps/desktop/src/lib/math-channels.ts) — vector-op pre-pass + lap-op error stubs
- [apps/desktop/src/components/MathChannelsModal.tsx](../apps/desktop/src/components/MathChannelsModal.tsx) — palette column + drag/click insert
