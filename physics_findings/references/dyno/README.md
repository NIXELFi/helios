# Calibration Dyno Datasets

Provenance + usage notes for each CSV in this directory. Spec reference: C10
(calibration-over-fit guard requires ≥ 2 distinct reference engines for any
*tuning* fix to reach `FIXED`).

Every CSV uses the columns:

```
rpm, brake_power_kW, brake_torque_Nm, bsfc_g_per_kWh, egt_K, source, notes
```

Where blank cells are documented in the row's `notes` column. RPM is the
engine crankshaft speed. `brake_power` and `brake_torque` are measured at the
crank or with a documented driveline-loss correction; `bsfc` and `egt_K` are
typically only available when an instrumented engine dyno (not a chassis dyno)
was used.

## Datasets

### `cbr600rr-fsae-restricted.csv`

- **Engine:** Honda CBR600RR (4-cylinder, 599 cm³, model years 2007-2018), with
  the SAE FSAE-mandated 20 mm intake restrictor.
- **Source:** Aggregate of FSAE.com archive thread t-1508 (multi-team
  published dynos, 2010-2018 era), Honda 600RR Forum dyno-chart-thread (similar
  era), plus the values referenced in this repo's `physics_synthesis.md` §1
  and §A1.
- **Range:** 41-52 kW peak at 12-14k RPM (published spread; individual teams
  cluster within ±2 kW around the rows in the CSV).
- **Provenance class:** Aggregated published dyno data. Treat individual rows
  as ±5 % accurate; treat the *envelope* (41-52 kW peak band) as authoritative.
- **Used by:** Every CBR600-related finding (Phase 1 #1, #4, #7, #11; Phase 2
  parameter audits).
- **Citation form in `finding.md`:**
  ```
  CBR600RR-FSAE-restricted aggregate, references/dyno/cbr600rr-fsae-restricted.csv
  (FSAE.com archive t-1508; physics_synthesis.md §1)
  ```

### `cbr600rr-stock-unrestricted.csv`

- **Engine:** Honda CBR600RR (4-cylinder, 599 cm³, model years 2007-2018),
  stock — no intake restrictor.
- **Source:** Honda Motor Co. factory power specification (88 kW / 118 hp
  @ 13500 RPM) cross-checked against Cycle World magazine published dynos
  (multiple model years; agreed to within 2-3 kW).
- **Range:** 88 kW peak @ ~13500 RPM, 64 N·m peak torque @ ~11000-12000 RPM.
- **Provenance class:** Factory-published spec + magazine corroboration.
  Highest-confidence dataset in the corpus.
- **Used by:** Solver-ceiling investigations (Phase 3 quasi-3D + Phase 4
  multi-engine cross-validation).
- **Citation form in `finding.md`:**
  ```
  CBR600RR stock unrestricted, references/dyno/cbr600rr-stock-unrestricted.csv
  (Honda factory spec + Cycle World published dyno)
  ```
- **Caveat:** The 17 % gap from the simulator's restricted-race-calibration
  output to the stock 88 kW is *known* (per two_zone_results.md): about 12 %
  remains as a 1D-vs-3D / chemistry modeling-class limit. Findings targeting
  this gap close to `CEILING-LIMIT` rather than `FIXED` if 3D-class corrections
  are needed.

### `fsae-ka100-single-cylinder.csv`

- **Engine (substituted):** Honda CRF250R (single-cylinder, 249.4 cm³, model
  years 2018-2022).
- **Substitution rationale:** The plan specifies the FSAE KA100 100cc kart
  engine as the second-engine reference but allows substitution if
  per-RPM published data is unavailable. The KA100's published dyno data is
  thin (peak ~17 hp claimed but few independent per-RPM curves); the CRF250R
  is widely instrumented in dirt-bike magazine reviews and has a closer
  geometric match (4-valve pent-roof, similar bore/stroke ratio) to CBR600.
  This makes the CRF250R the **more useful** second-engine corpus for the
  heat-transfer / friction / Wiebe-shape investigations in Phase 1.
- **Filename note:** The filename is retained as `fsae-ka100-single-cylinder.csv`
  per the plan's file-list; the *content* is CRF250R.
- **Source:** Honda Motor Co. factory power claim (~27 kW / 36 hp peak)
  cross-checked against Motocross Action and Dirt Rider published dyno
  articles (2018-2020 model years). Magazine articles publish power+torque but
  not BSFC or EGT; those columns are blank.
- **Range:** ~27 kW peak @ ~10500 RPM, ~26 N·m peak torque @ ~8500 RPM.
- **Provenance class:** Factory spec + magazine corroboration. Roughly ±5 %
  accurate per row.
- **Used by:** C10 second-engine validation gate. Any Phase 1 *tuning* fix
  must pass validation against both this dataset and the CBR600 corpus before
  closing as `FIXED`.
- **Citation form in `finding.md`:**
  ```
  CRF250R (substituted for KA100), references/dyno/fsae-ka100-single-cylinder.csv
  (Honda factory + Motocross Action published dynos)
  ```

## Future datasets (Phase 4)

Per spec C10 + Phase 4 broadening, ≥ 2 *additional* engines beyond CBR600
will be added for cross-validation:

- Yamaha R1 (1000cc inline-4, well-documented FSAE choice) — published
  power 142 kW unrestricted; restricted to 70-90 kW with 20 mm restrictor.
- Briggs LO206 (200cc single, "spec" karting engine) — published in tight
  shootout articles with low spread.
- Subaru EJ20 / Ford EcoBoost-class (production-car benchmark) — for
  comparison against published GT-POWER / Ricardo WAVE calibration cases.

These remain TODO. They will follow the same CSV format.

## Validation procedure

When a tuning fix updates a coefficient (e.g., `woschni_c1_scale` or
`tumble_burn_factor`), the C10 gate requires:

1. Run the simulator at the CBR600 race calibration → confirm metric matches
   `cbr600rr-fsae-restricted.csv` envelope at peak-power RPM.
2. Run the simulator at the second-engine calibration (CRF250R) → confirm
   metric matches `fsae-ka100-single-cylinder.csv` envelope at peak-power RPM.
3. Both passes required for `FIXED`. One-engine validation = `FIX-IN-PROGRESS`.

*Bug-fix* findings (wiring errors, sign flips, missed source terms) are
exempt from C10 — they fix incorrect behavior and need only the original
CBR600 calibration regression to confirm no regression.
