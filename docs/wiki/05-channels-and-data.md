# Channels & data ingest

Helios's data model has four layers:

```
CSV file → loader (Rust)  →  RateGroups (Arrow)  →  ChannelStore (TS)  →  widgets
                                    ↑
                            channels.yaml registry
                                    +
                            smart resolver
```

## Canonical channel registry — `docs/channels.yaml`

Every recognized channel has an entry like:

```yaml
- id: engine.tps
  display_name: Throttle Position
  units: "%"
  group: Engine
  color: "#4FC3F7"
  decimals: 1
  data_type: f32
  source: link_g4x
  sample_rate_hz: 100
  min: 0
  max: 100
  aliases: [tps, TPS, throttle, throttle_pct, "Throttle Position", ...]
  match_keywords: [tps, "throttle position", "throttle pos", "throttle plate"]
  match_units: ["%"]
```

Field reference:

| Field | Purpose |
| --- | --- |
| `id` | Dotted canonical id used everywhere (`engine.rpm`, `gps.lat`). |
| `display_name` | Human label shown in pickers and inspectors. |
| `units` | Display units. |
| `group` | Category for the channel inspector (Engine, GPS, IMU, Brake, …). |
| `color` | Default trace color. |
| `decimals` | Display precision. |
| `data_type` | Arrow type (`f32`, `f64`, `u16`, `bool`, `enum`). |
| `source` | Provenance label (`link_g4x`, `motec`, `imu`, …). |
| `sample_rate_hz` | Canonical sample rate. |
| `min / max / warn / alarm` | Optional ranges & thresholds. |
| `aliases[]` | Exact CSV header strings that resolve directly to this id (fast path). |
| `match_keywords[]` | Tokens used for semantic fallback when no alias matches. |
| `match_units[]` | Allowed source units for semantic match — prevents `Oil Pressure` (kPa) grabbing `engine.oil_temp` (°C). |

**To add a channel:** append an entry. Next CSV load picks it up. No code change required.

## Supported CSV formats

The loader (`crates/helios-csv/src/load.rs`) auto-detects three flavors:

1. **MoTeC i2** exports — preamble starts with `"Format","MoTeC`. Loader strips ~12 metadata rows + units row; deduplicates a second `Time` column to `Time_1`.
2. **Link ECU** dataloggs — preamble starts with `"Name","ECU Internal Datalog`. Single header line stripped.
3. **Plain time-series CSV** — semicolon or comma delimited; first column is time.

Quirks handled:

- Non-UTF-8 bytes (e.g. Latin-1 degree sign) are lossy-decoded to U+FFFD rather than rejecting the file.
- The MoTeC ADL GPS int32-as-uint32 quirk: lat/lon values past ±1000 are treated as unsigned int32 micro-degrees and rescaled in the GPS widget. (See [Widgets reference → GPS Track](04-widgets-reference.md#gps-track).)

## Smart channel resolver

The resolver runs in three layers per column:

| Layer | What it does | When it wins |
| --- | --- | --- |
| **1. Exact alias** | Direct match against `aliases[]` lists | Precise vendor headers ("Engine Speed", "ECU TPS") |
| **2. Semantic match** | Tokenize source header, search `match_keywords[]` contiguous-run; gate by `match_units[]` | Vendor variants we haven't curated |
| **3. Default** | Synthesize ChannelMeta from raw header + inferred units | Unknown columns; always reachable under their raw name |

The loader does a **two-pass run**:

1. Every column gets first crack at exact-alias resolution. First wins.
2. Anything still unmapped gets the semantic match, skipping canonical ids already claimed.
3. Anything still unmapped becomes a default custom channel.

A collision protection rule keeps the **first** mapping if two columns resolve to the same id; the loser demotes to its raw header and a warning is logged. This is why `Throttle Position` and `Throttle Load` (both `%`) no longer fight for `engine.tps`.

**Unit gate** matters: when both keyword and unit match, score is bonused. When the source row has no units, the threshold tightens — so an ambiguous "GP RPM Limit 1" can't confidently route to `engine.rpm`.

### Per-session channel overrides

If the auto-resolver picks the wrong CSV column for a per-vehicle quirk, you can fix it manually:

1. Header → **Channels**.
2. Scroll to the canonical channel; click its **Source** column.
3. Pick a different CSV header from the popover. The override saves to `localStorage` under `helios.channel-overrides.v1.<sessionId>` and survives reloads.
4. Click **Reset to auto** to revert.

Overridden rows are highlighted yellow in the inspector.

## Rate groups & multi-rate handling

Channels at different sample rates live in separate **rate groups**. Each `RateGroup` has its own time index (`BigInt64Array` of µs) and column buffers (`Float64Array` per channel). The loader rounds each column's rate to the nearest known group; if no group matches, it creates one.

Leading gaps in a channel preserve as Arrow nulls (not NaN); interior gaps forward-fill with the last-known sample.

When a widget asks for `slice` over `[startUs, endUs)`, the store binary-searches each rate group for the lo/hi sample indices and returns time + per-channel `Float64Array` slices. Cross-rate-group reads (e.g. math channels that mix 100 Hz and 1 kHz) resample via binary search at the base-group's time indices.

## The channel store

Each loaded CSV has its own `ChannelStore`:

```typescript
class ChannelStore {
  #metas: Map<string, ChannelMeta>;          // canonical id → metadata
  #channelToGroup: Map<string, string>;      // channel id → rate group id
  #groups: Map<string, RateGroup>;
  #bySourceHeader: Map<string, string>;      // CSV header → channel id that owns it
  #overrides: Map<string, string>;           // canonical id → source header override

  get(id): ChannelMeta | undefined;
  groupOf(channelId): RateGroup | undefined;
  setChannelOverride(canonicalId, sourceHeader): void;
  effectiveChannelId(canonicalId): string;
  // ...
}
```

When a widget reads `engine.tps`, `effectiveChannelId` looks up any active override and routes the read to whichever CSV column the user has chosen.

## Loader output

```rust
pub struct LoadResult {
    pub rate_groups: Vec<RateGroup>,   // grouped by sample rate
    pub warnings: Vec<String>,         // semantic maps, unknowns, parse failures
    pub duration_us: i64,
}
```

Warnings surface in the loading screen's stage label as it processes each session.

## Adding a new channel

1. Open [`docs/channels.yaml`](../channels.yaml).
2. Add an entry with `id`, `display_name`, `units`, `group`, `color`, `data_type`, `sample_rate_hz`.
3. Populate `aliases[]` with any vendor CSV header you want exact-matched.
4. Populate `match_keywords[]` + `match_units[]` for tolerant matching across vendor variants.
5. Reload the CSV. The channel appears in every picker and the inspector.

## Adding a new CSV format

1. Add a preamble detector in [`crates/helios-csv/src/load.rs`](../../crates/helios-csv/src/load.rs) (look at `preprocess_motec_if_needed` for the pattern).
2. Strip metadata rows; find the header + units row; deduplicate if needed.
3. Add a fixture under [`fixtures/good/`](../../fixtures/good/) and a test in `load.rs`.

## Reference files

| File | Role |
| --- | --- |
| [`docs/channels.yaml`](../channels.yaml) | The canonical registry (1280+ lines). |
| [`crates/helios-csv/src/load.rs`](../../crates/helios-csv/src/load.rs) | Loader entry, preamble detectors, multi-pass resolution. |
| [`crates/helios-csv/src/registry.rs`](../../crates/helios-csv/src/registry.rs) | Resolver: exact, semantic, default. |
| [`crates/helios-core/src/rate_group.rs`](../../crates/helios-core/src/rate_group.rs) | Rust RateGroup definition. |
| [`packages/store/src/rate-group.ts`](../../packages/store/src/rate-group.ts) | TS zero-copy wrapper. |
| [`packages/store/src/channel-store.ts`](../../packages/store/src/channel-store.ts) | TS ChannelStore + overrides. |
| [`apps/desktop/src/components/ChannelsModal.tsx`](../../apps/desktop/src/components/ChannelsModal.tsx) | Channel inspector UI. |
