# 05 — Loading real MoTeC CSV data

## Symptom

Helios was hardcoded to load `samples/sdm26-synthetic-lap.csv`, a synthetic lap. Real session data — exported from MoTeC i2 as `SDM26-5-3-Best_Accel.csv` — could not be loaded by the existing CSV pipeline. The MoTeC export format starts with ~12 lines of metadata, has channel names on one row, units on another, blanks between sections, and quoted values throughout.

```
"Format","MoTeC CSV File",,,"Workbook",""
"Venue","Track",,,"Worksheet",""
"Vehicle","Vehicle",,,"Vehicle Desc",""
... 9 more metadata rows ...
"Beacon Markers",""


"Time","Distance","Time","Front Brake Pressure","Rear Brake Pressure",...
"s","m","min","kPa","kPa",...


"0.000","0","1","651","1640",...
```

The existing loader assumed row 0 was the channel header and row 1 was data, so it tried to parse `"Format"` as a time value and failed.

## Root cause

Two parts of the MoTeC format break the loader:

1. **Metadata block before the header.** Twelve+ lines of `"Key","Value"` pairs that aren't channel data.
2. **Units row immediately after the header.** Every cell is a unit string (`"s"`, `"kPa"`, etc.), which the loader would otherwise treat as the first data row and fail to parse.

There is also a smaller quirk: MoTeC reuses the column name `"Time"` for both the relative-seconds column (the time index) and an absolute-minutes clock further into the row, which would collide in the channel id map.

## Fix

### 1. MoTeC preprocessor in [crates/helios-csv/src/load.rs](../crates/helios-csv/src/load.rs)

Added a `preprocess_motec_if_needed(text)` step that runs before the CSV reader. It is gated on a literal-prefix check (`"Format","MoTeC`) so non-MoTeC files pass through unchanged.

When MoTeC is detected:
- Skip metadata rows until the first row whose first cell is exactly `"Time"` — that is the channel header.
- Skip the units row that follows, plus any blanks, until a row whose first cell parses as a float (the first data row).
- Rewrite the header line with deduplicated column names so a second `"Time"` column becomes `Time_1`.

The output is a synthetic CSV that the existing reader handles without modification. Quoted values are unwrapped by the standard `csv` crate.

### 2. Channel aliases in [docs/channels.yaml](../docs/channels.yaml)

Added MoTeC display names to each canonical channel's `aliases` list so widgets keep referring to `engine.rpm`, `gps.lat`, etc., even when the source CSV uses `"Engine Speed"`, `"GPS Latitude"`, etc.

| Canonical id | MoTeC alias added |
|--------------|-------------------|
| `engine.rpm` | `Engine Speed` |
| `engine.tps` | `Throttle Position`, `APS Main` |
| `engine.water_temp` | `Engine Coolant Temp` |
| `engine.oil_temp` | `Engine Oil Temp` |
| `engine.gear` | `Gear Position` |
| `gps.lat` | `GPS Latitude` |
| `gps.lon` | `GPS Longitude` |
| `gps.speed` | `GPS Speed` |
| `imu.lat_g` | `Lat_Accel` |

### 3. Bundle the real file

[apps/desktop/src-tauri/tauri.conf.json](../apps/desktop/src-tauri/tauri.conf.json) now bundles `SDM26-5-3-Best_Accel.csv` from the repo root as `samples/sdm26-best-accel.csv`, and [apps/desktop/src/lib/load-sample.ts](../apps/desktop/src/lib/load-sample.ts) loads that resource on startup.

## Tests

- New Rust test `loads_motec_format_via_aliases` in [load.rs](../crates/helios-csv/src/load.rs) loads a hand-written minimal MoTeC fixture ([fixtures/good/motec_minimal.csv](../fixtures/good/motec_minimal.csv)) and asserts the canonical channels resolve through the alias map.
- All existing CSV tests (25) still pass.

## Known caveats

- The MoTeC export's `"GPS Latitude"` / `"GPS Longitude"` columns are stored as raw integers (no scaling), not decimal degrees. The GPS track widget will draw, but the projected dot may not correspond to a real-world position until we add a per-channel decode step. Logged separately — fix not in scope here.
- The duplicate `"Time"` column (absolute clock, in minutes) is preserved as `Time_1` and treated as an unknown channel. It doesn't appear on any widget but may show up if you list all channels. Future work could drop it explicitly in the preprocessor.

## Files changed

- [crates/helios-csv/src/load.rs](../crates/helios-csv/src/load.rs)
- [docs/channels.yaml](../docs/channels.yaml)
- [apps/desktop/src-tauri/tauri.conf.json](../apps/desktop/src-tauri/tauri.conf.json)
- [apps/desktop/src/lib/load-sample.ts](../apps/desktop/src/lib/load-sample.ts)
- [apps/desktop/src/App.tsx](../apps/desktop/src/App.tsx) — header label updated to `SDM26-5-3-Best_Accel.csv`
- [fixtures/good/motec_minimal.csv](../fixtures/good/motec_minimal.csv) — new test fixture
