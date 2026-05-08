# 32 · smart channel resolver — MoTeC / Link interop · v2.5.2

Workspaces no longer "explode" when you swap a session for one from a
different ECU vendor. The CSV loader now resolves channel headers in three
layers, falling through in order:

1. **Exact alias** — same as before. `engine.rpm`, `RPM`, `Engine Speed`, etc.
2. **Semantic match** *(new)* — tokenize the source header (lowercase,
   strip punctuation, collapse whitespace), check whether any of the
   canonical channel's `match_keywords` phrases appear as contiguous
   tokens. The CSV's units row gates the match: if the canonical declares
   `match_units`, the source unit must agree before the heuristic accepts.
3. **Default** — synthesize a custom channel from the raw header.

A semantic match emits a warning so users can audit what got auto-routed.

## Why this works for MoTeC ↔ Link in particular

MoTeC and Link both export units alongside data. That means the resolver
can confidently disambiguate cases like:

| Source header | Source unit | Resolves to | Path |
| --- | --- | --- | --- |
| `Engine Speed` | RPM | `engine.rpm` | exact alias |
| `TPS (Main)` | % | `engine.tps` | exact alias (new) |
| `Throttle Pedal Pos` | % | `engine.tps` | semantic (`throttle` + %) |
| `Oil Temperature` | °C | `engine.oil_temp` | exact alias (new) |
| `Oil Pressure` | kPa | `engine.oil_pressure` | exact alias (new) |
| `Coolant Bypass Pressure` | kPa | (custom channel) | unit gate rejects water_temp |
| `GP RPM Limit 1` | (none) | (custom channel) | strict mode — unit unknown, single keyword |

The unit gate is the load-bearing piece. Without it, "Oil Pressure" (kPa)
would semantic-match `engine.oil_temp` because "oil" is a keyword for both.
With the gate, only the °C side accepts it; the kPa channel routes to
`engine.oil_pressure` which has its own keyword + unit.

## Strictness when the source has no units

Plain CSVs (no MoTeC or Link preamble) don't have a units row. Semantic
matching then tightens its threshold — a single keyword match isn't enough,
two are required. Most legitimate channel names hit only one keyword, so
plain CSVs continue to rely on the explicit alias list (which is the
predictable layer and got expanded in this release too).

## YAML schema additions

Each canonical channel can now declare:

```yaml
match_keywords: ["engine speed", "engine rpm"]   # phrase-level matching
match_units: [RPM, rpm]                          # acceptable units (normalized)
```

Unitless canonicals (e.g. `engine.gear`) deliberately leave
`match_keywords` empty — too many unrelated names contain "gear" for
keyword-only matching to be safe. They keep working via the alias list.

## What now resolves automatically

- **Engine RPM:** `RPM`, `Engine Speed`, `Engine RPM`, `n_engine`, plus any
  variant whose normalized name contains `engine speed` / `engine rpm` and
  has unit `RPM`.
- **Throttle:** `TPS`, `Throttle Position`, `TPS (Main)/(Sub)`, `APS Main`,
  `APS (Main)/(Sub)`, `Throttle Pos`, plus anything containing `throttle` /
  `tps` / `accelerator pedal` with unit `%`.
- **Coolant:** `ECT`, `Engine Coolant Temp`, `Coolant Temp`, `Water Temp`,
  plus anything matching `coolant` / `water temp` / `ect` with unit `°C`.
- **Oil temp:** `Oil Temperature`, `Engine Oil Temp`, `Oil Temp`, plus
  `oil temp` / `oil temperature` patterns with unit `°C`.
- **Oil pressure** (new canonical channel): `Oil Pressure` and the kPa
  variants. Wasn't a canonical channel before, but it's part of every
  Link export and appears in MoTeC too.
- **Fuel pressure** (new): `Fuel Pressure` + variants.
- **MAP** (new): `MAP`, `Manifold Pressure`, `Manifold Abs Pressure`.
- **Lambda** (new): `Lambda`, `Lambda 1`, `Wideband Lambda`.
- **Battery voltage** (new): `Batt Voltage`, `Battery Voltage`, `Battery Volts`.
- **Long G** (new): paired with the existing Lat G channel.

Plus everything from before (steering angle, GPS, beacons, etc.).

## Files

- `crates/helios-csv/src/registry.rs` — `SemanticPattern`, `try_semantic`,
  unit normalization with synonym table, `ResolveKind::{ExactAlias,
  Semantic, Default}` discriminator.
- `crates/helios-csv/src/load.rs` — preamble strippers refactored into a
  unified `prepare_csv_input` that captures the per-column units row.
  `LoadResult.warnings` now distinguishes "semantic-mapped" entries from
  "registered with defaults" entries.
- `docs/channels.yaml` — expanded aliases for the common Link/MoTeC
  variants, semantic patterns for keyword-eligible canonicals, four new
  canonical channels (oil_pressure, fuel_pressure, map, lambda,
  battery_voltage, long_g — actually six).

## Tests added

- `registry::semantic_matches_tps_with_parens` — explicit alias-miss path.
- `registry::semantic_units_disambiguate_oil_temp_vs_pressure` — same
  keyword (`oil`), different units, routed correctly.
- `registry::semantic_strict_when_unit_unknown` — falls through to default
  rather than guess on single-keyword + missing-unit.
- `registry::semantic_word_boundary_avoids_false_positive` — `Inrpmthing`
  doesn't grab `engine.rpm` despite containing the letters `rpm`.
- `load::semantic_mapping_via_units_row` — end-to-end through the units
  row, with a warning emitted for audit.
- `load::semantic_unit_mismatch_falls_through` — unit gate prevents
  cross-physics false positives.

35/35 helios-csv tests pass.
