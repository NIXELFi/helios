# Calibration Dyno Datasets

Provenance + usage notes for each CSV in this directory. Spec reference: C10
(calibration-over-fit guard). For Phase 0–2 the C10 "two-calibration baseline"
is **SDM25 + SDM26**, both modeling the Honda CBR600RR with different solver
calibrations (pre-Phase-F vs current). Phase 4 broadens to external engines.
See `docs/superpowers/specs/2026-05-22-physics-agent-loop-design.md` §C10
"Phase reconciliation" for the rationale.

Every CSV uses the columns:

```
rpm, brake_power_kW, brake_torque_Nm, bsfc_g_per_kWh, egt_K, source, notes
```

Where blank cells are documented in the row's `notes` column. RPM is the
engine crankshaft speed. `brake_power` and `brake_torque` are measured at the
crank or with a documented driveline-loss correction; `bsfc` and `egt_K` are
typically only available when an instrumented engine dyno (not a chassis dyno)
was used.

## CBR600RR dyno corpus

Both SDM25 and SDM26 configurations target this corpus. A tuning fix that
helps SDM26 land on the CBR600 envelope but moves SDM25 *off* it reveals
coefficient-level over-fit even though the physical engine is the same.

### `cbr600rr-fsae-restricted.csv`

- **Engine:** Honda CBR600RR (4-cylinder, 599 cm³, model years 2007–2018),
  with the SAE FSAE-mandated 20 mm intake restrictor.
- **Source:** Aggregate of FSAE.com archive thread t-1508 (multi-team
  published dynos, 2010–2018 era), Honda 600RR Forum dyno-chart-thread (similar
  era), plus the values referenced in this repo's `physics_synthesis.md` §1
  and §A1.
- **Range:** 41–52 kW peak at 12–14k RPM (published spread; individual teams
  cluster within ±2 kW around the rows in the CSV).
- **Provenance class:** Aggregated published dyno data. Treat individual rows
  as ±5 % accurate; treat the *envelope* (41–52 kW peak band) as authoritative.
- **Used by:** Every CBR600-related finding (Phase 1 #1, #4, #7, #11; Phase 2
  parameter audits). Both SDM25 + SDM26 must hit this envelope.

### `cbr600rr-stock-unrestricted.csv`

- **Engine:** Honda CBR600RR, stock — no intake restrictor.
- **Source:** Honda Motor Co. factory power specification (88 kW / 118 hp
  @ 13500 RPM) cross-checked against Cycle World magazine published dynos
  (multiple model years; agreed to within 2–3 kW).
- **Range:** 88 kW peak @ ~13500 RPM, 64 N·m peak torque @ ~11000–12000 RPM.
- **Provenance class:** Factory-published spec + magazine corroboration.
  Highest-confidence dataset in the corpus.
- **Used by:** Solver-ceiling investigations (the documented 1D-vs-3D /
  chemistry modeling-class limit at ~12 % below this number).
- **Caveat:** The 17 % gap from the simulator's restricted-race-calibration
  output to the stock 88 kW is *known* (per two_zone_results.md): about 12 %
  remains as a 1D-vs-3D / chemistry modeling-class limit. Findings targeting
  this gap close to `CEILING-LIMIT` rather than `FIXED` if 3D-class corrections
  are needed.

## The SDM25 + SDM26 two-calibration baseline (C10)

Both solver calibrations live in the repo and have full parity fixtures:

- **SDM26:** `crates/engine-sim/python_ref/configs/sdm26.json` — current
  calibration. Parity fixtures under
  `crates/engine-sim/fixtures/parity/engine_matrix_sdm26_*` (4k → 13k RPM,
  both junction kinds).
- **SDM25:** `crates/engine-sim/python_ref/configs/sdm25.json` — pre-Phase-F
  calibration. Parity fixtures under
  `crates/engine-sim/fixtures/parity/engine_matrix_sdm25_*` (4k → 12k RPM,
  both junction kinds).

These are two *solver calibrations* of the same *physical engine*. A fix that
moves SDM26 toward the CBR600 envelope must also move SDM25 toward it (or at
least not move it away). Divergence between the two calibrations under the
same fix is evidence of coefficient over-fit to SDM26's specific tune.

The `0000-phase0-smoke` finding exercises both calibrations end-to-end as
the Phase 0 acceptance gate.

## Future datasets (Phase 4)

Per spec C10 + Phase 4 broadening, ≥ 2 *external* engines beyond CBR600 will
be added for true cross-engine validation:

- **Honda CRF250R** (single-cylinder, 249.4 cm³) — published peak ~27 kW @
  ~10500 RPM, peak torque ~26 N·m @ ~8500 RPM. Factory spec + Motocross
  Action / Dirt Rider published dyno corroboration. Closer geometric match to
  CBR600 than the KA100 (4-valve pent-roof, similar bore/stroke ratio) and
  better-instrumented in published reviews.
- **Yamaha R1** (1000cc inline-4, well-documented FSAE choice) — published
  power 142 kW unrestricted; restricted to 70–90 kW with 20 mm restrictor.
- **Briggs LO206** (200cc single, "spec" karting engine) — published in
  tight shootout articles with low spread.
- **Subaru EJ20 / Ford EcoBoost-class** (production-car benchmark) — for
  comparison against published GT-POWER / Ricardo WAVE calibration cases.

These remain TODO and follow the same CSV format. Until they land, C10
"second-engine validation" means the SDM25-vs-SDM26 cross-calibration check.

## Validation procedure (C10 gate)

When a *tuning* fix updates a coefficient (e.g., `woschni_c1_scale`,
`tumble_burn_factor`, `fmep_a`), the C10 gate requires:

1. Run the simulator with the **SDM26** config + the fix → measured metric
   matches the CBR600 envelope at peak-power RPM.
2. Run the simulator with the **SDM25** config + the fix → measured metric
   *also* matches the CBR600 envelope at peak-power RPM (within the same
   tolerance band — both are the same physical engine).
3. Both passes required for `FIXED`. One-calibration pass = `FIX-IN-PROGRESS`.

When external corpus lands (Phase 4), step 2 broadens to "additionally run
against the secondary engine config" — but the SDM25 cross-check remains as
the cheapest first-line check.

*Bug-fix* findings (wiring errors, sign flips, missed source terms) are
exempt from C10 — they fix incorrect behavior and need only the original
CBR600 calibration regression to confirm no regression.

## Caveats noted by content corpus authors

These were surfaced when this corpus was first assembled and remain open
items for Phase 1 investigations:

- **CBR600 per-RPM BSFC + EGT columns are blank.** The source articles
  (FSAE.com archive threads, 600RR forum dynos) typically publish only power
  + torque. If precise BSFC/EGT per-RPM is required, an instrumented
  engine-dyno reference (rather than chassis dyno aggregate) would need to
  be sourced. Phase 1 findings depending on BSFC validation should call this
  out in their `[acceptance]` block as a `LITERATURE-AMBIGUOUS` candidate.
- **CBR600 6000–9000 RPM power values** are interpolated from the published
  peak-band data (41–52 kW at 10–14k RPM) and the well-known torque-curve
  shape; individual rows in this band have wider uncertainty (±15% per row)
  than the peak band (±5%).
- **NASA-7 coefficient pin in `references/literature/burcat-nasa7-coefficients.md`**
  recommends Burcat 2005-09. The existing engine-sim `thermo.rs` (if it
  exists) may use an older snapshot; a Phase 1 / Phase 3 chemistry finding
  must reconcile.
