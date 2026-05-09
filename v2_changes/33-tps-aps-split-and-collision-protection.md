# 33 · split TPS / APS + channel collision protection · v2.5.3

Two fixes to channel resolution that were entangled in one user-visible
symptom: "TPS isn't working when I switch between logs."

## What was broken

In v2.5.2 the channel registry aliased `APS Main`, `APS (Main)`, `APS Sub`,
and `APS (Sub)` to `engine.tps`, alongside the actual `TPS (Main)` /
`TPS (Sub)` aliases. That's wrong on two counts:

1. **TPS and APS are physically distinct sensors.** TPS (Throttle Position
   Sensor) measures throttle plate angle — what the engine actually saw. APS
   (Accelerator Pedal Sensor) measures driver pedal input — what the driver
   asked for. In any drive-by-wire setup (and many cable-throttle setups)
   they intentionally diverge during idle correction, traction control,
   launch limits, etc. Collapsing them at the data layer destroys exactly
   the signal a tuner is looking for.

2. **Multiple columns with the same canonical id silently collide.** When
   `TPS (Main)`, `TPS (Sub)`, `APS (Main)`, and `APS (Sub)` all resolved to
   `engine.tps`, `RateGroup::build`'s HashMap kept only the LAST one. Any
   widget configured for `engine.tps` would render whichever Link column
   happened to be loaded last (APS Sub) instead of actual TPS — hence the
   "TPS isn't working" symptom.

## The fix

**Split TPS and APS into separate canonical channels:**

| Canonical id | Source headers (alias) | Semantic keywords |
| --- | --- | --- |
| `engine.tps` | `TPS`, `Throttle Position`, `Throttle Pos`, `TPS Main`, `TPS (Main)` | `tps`, `throttle` |
| `engine.tps_sub` | `TPS Sub`, `TPS (Sub)` | (none — alias only, diagnostic) |
| `engine.aps` | `APS`, `APS Main`, `APS (Main)`, `Accelerator Pedal`, `Accelerator Pedal Position`, `Pedal Position`, `Pedal Pos` | `aps`, `accelerator pedal`, `pedal pos`, `pedal position` |
| `engine.aps_sub` | `APS Sub`, `APS (Sub)` | (none — alias only, diagnostic) |

The semantic-keyword sets are intentionally **disjoint** — the resolver
will never grab a TPS channel for the APS canonical or vice versa.

**Collision protection in the loader.** Even when the registry is right, a
source CSV could still have two columns that both resolve to the same
canonical id (rare, but possible across vendors). The loader now keeps
the FIRST mapping and demotes subsequent collisions back to their raw
header name so all columns stay reachable. Each demotion emits a warning:

> `channel \`FOO_B\` resolved to \`engine.foo\` but that id was already
> claimed by an earlier column; storing as \`FOO_B\` instead so both
> remain reachable`

This is a defense-in-depth fix — the YAML split eliminates the immediate
case, and the loader guard catches anything we miss in the future.

## What you'll see after upgrading

For a workspace tile configured for `engine.tps` and a Link CSV with
all four pedal/throttle columns:

- v2.5.2 (broken): the tile shows APS Sub data, mis-labelled as TPS.
- v2.5.3 (fixed): the tile shows real TPS Main data. To see APS, the
  user picks `engine.aps` explicitly. To see the redundant sub-sensors,
  pick `engine.tps_sub` / `engine.aps_sub`.

You'll need to **reload your sessions** for the fix to apply — the
mapping happens at load time, so already-loaded sessions keep their old
(incorrect) channel layout until re-imported.

## Tests

- `load::collision_protection_keeps_both_columns_reachable` — inline
  registry where two aliases route to the same id; verifies first wins,
  second falls back to raw header, and a warning is emitted.
- All previous registry + load tests continue to pass.

36/36 helios-csv tests green.

## Files

- `docs/channels.yaml` — split engine.tps / engine.tps_sub / engine.aps /
  engine.aps_sub.
- `crates/helios-csv/src/load.rs` — `claimed_ids` HashSet; raw-header
  fallback on collision with warning.
