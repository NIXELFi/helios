# Handoff: engine-sim accuracy work (2026-09-29)

**Branch:** `fix/engine-sim-accuracy-0929` (from `main` @ `3d6073d0`)
**Goal:** get the 1D engine model (`crates/engine-sim`) as close to the real SDM26 as possible before designing an **active / variable runner-length intake** this season.

## Update (later 2026-09-29): finding 0035

Next steps 1-4 are done. See `physics_findings/0035-collector-merge-lambda-lag/finding.md`.

- **Collector (step 1):** the new `physics.exhaust_junction_momentum` merge model is the one change that moves shape.
  - Dyno-torque shape r goes 0.70 → 0.79, ECU r (270 ms) goes 0.52 → 0.56, and the 9k peak is restored.
  - It does **not** make the 7.4-8k trough (model −0.06 vs car −0.25).
- **Bends / muffler (step 2):** `local_losses` are small effects and not a trough mechanism.
- **γ/R (step 4):** `physics.exhaust_gas_gamma/_r` give 2.3 % slower exhaust waves. The model trough moves to 7.9k, which is correct but small.
- **Best dyno fit:** real tune + all three, with RMSE 2.66 kW over 6-12.5k and 1.89 kW over 7-11.5k (was 2.78 / 2.36).
  The 10.5-12.5k band gets worse (3.54 vs 3.02), which is the level problem for step 5.
- **Proxy (step 3): the 270 ms λ lag is the closed-throttle lag.**
  - WOT ignition cuts in the raw log show about 90 ms.
  - With the WOT lag (`references/ecu/proxy_wotA.csv`, **use this instead of proxy_lag270**) the car's trough is −0.25, not −0.40.
  - It is real, but a third of it was lag.
  - The dyno features sit 4-10 % lower in rpm than the ECU's. Check how the dyno derives rpm (`ERpmM`).
- **New framing:** the model has roughly the car's phase but about 1/6 of its in-phase VE ripple (slope 0.16; car ripple 8.7 %
  in both the proxy and the dyno, model 3 %). The next hunt is wave amplitude (damping or excitation), not one trough.
  Top candidates are valve lift/Cd tables, wall friction/heat, and cylinder blowdown. A fast pressure trace would settle it.
- The raw log is in the vault as a **gzip** object. Gunzip it before `load.py`.

## TL;DR — where it stands

- The pipe solver is numerically sound. Wave speed is within 0.3%, and results are grid- and cycle-converged.
- The shipped model (V1) matches dyno power (2.69 kW RMSE) but has the VE shape roughly **backwards** vs the car: correlation with the ECU VE proxy is −0.18.
- Fixing physics bugs, adding the real cam, and adding the measured intake and 4-2-1 exhaust takes the shape correlation to **+0.52–0.60**. The car's **6.3k VE peak** is now in the right place, with no re-fitting to the dyno.
- **Still wrong:** there is no 7.4–8.0k VE trough (the dyno shows a dip at 6.5–7.5k), the 9k peak is too flat, and the model reads 3–5 kW high above 10.5k.
- The shipped app configs (`sdm26.json`, `sdm25.json`) are **unchanged**. All new physics is opt-in, `SDM26Config::default()` parity is frozen, and the parity suite is green.

| Model | ECU VE-shape r | Dyno RMSE 6–12.5k | 7–11.5k | 10.5–12.5k |
|---|---|---|---|---|
| V1 shipped `sdm26.json` | −0.18 | 2.69 kW | 2.71 | 3.85 |
| As-built intake (`sdm26_asbuilt.json`) | +0.20 | 2.59 | 2.05 | 2.71 |
| + as-built exhaust (`sdm26_asbuilt_exhaust.json`) | +0.52 | 2.98 | 2.29 | 3.93 |
| + real tune (`sdm26_asbuilt_realtune.json`) | +0.52 | 2.78 | 2.36 | 3.02 |

Wheel power is compared as sim brake × 0.85. The proxy uses a 270 ms λ lag.

## Commits on this branch

| Commit | What |
|---|---|
| `802d75ca` | Opt-in physics fixes from the 0929 audit (finding 0032): directional intake junction loss, venturi restrictor with T0-conserving inlet and diffuser recovery, configurable plenum, runner/collector end corrections, physical exhaust open end, fuel from air + O2-limited burn, cam events at 1 mm lift |
| `7956f9f7` | Load the new flags from JSON; **warn on unknown/misspelled config keys** |
| `c9ad4b4d` | App hygiene: templates = shipped configs, optimization 40/30 cycles + preset, stagnation junction labelled "not for wave tuning", `[[sweep.grid]]` (one sweep per runner length), v2 example configs |
| `857d6670` | Finding 0032 + CHANGELOG |
| `0d1fff6e` | Shaped plenum / runner `diameter_profile`, `restrictor.outlet_diameter`, `sdm26_asbuilt.json` |
| `c3391995` | Finding 0033 (as-built intake) |
| `10c35544` | Exhaust `diameter_profile`, per-rpm `physics.afr_map`, `sdm26_asbuilt_exhaust.json`, `sdm26_asbuilt_realtune.json` |
| `998d8dcb` | Finding 0034 (as-built exhaust + real tune) |
| (this commit) | This handoff + ECU reference data/scripts |

Nothing has been released. Before merging: the Tauri crate change in `apps/desktop/src-tauri/src/cfd/commands.rs` (example-config registration) is **compile-unverified**, because `cargo check` of the Tauri crate fails on the work machine (mingw toolchain). Build the desktop app once on a working machine.

## Where to read

- `physics_findings/0032-audit-0929-physics-fixes/finding.md` covers the physics fixes and validation.
- `physics_findings/0033-sdm26-asbuilt-intake/finding.md` covers the intake geometry and the port-length sweep.
- `physics_findings/0034-sdm26-asbuilt-exhaust/finding.md` covers the exhaust geometry, sensitivity and real tune (`fig_exhaust.png`, `fig_sens.png`).
- Audit report (artifact): https://claude.ai/artifact/GxEfpu7CjPfx81GRqypp9c
- Charts, best model vs dyno: https://claude.ai/artifact/FtgFbL6FYvd3EwSF6FKvKS

## Measured SDM26 geometry (from Nick, 2026-09-29)

**Engine:** 2007 CBR600RR (PC40). Service manual valve timing @ 1 mm lift: IN 21° BTDC / 44° ABDC, EX 40° BBDC / 5° ATDC. CR 12.2. Peak lift 8.56/7.35 mm in the config (unverified).

**Intake:**
- **Throttle and restrictor:** 32 mm Bosch butterfly, then a 228 mm restrictor made up of a Ø36→Ø20 converging section at 8° half-angle (~57 mm), a 10 mm Ø20 throat, and a 3.2° diffuser to Ø38 (~161 mm).
- **Plenum:** axisymmetric, top-fed bell. 1.44 L, lofting Ø38 → Ø167.
- **Runners:** 4 curved runners from the plenum floor. 235.4 mm body plus a 12.7 mm bellmouth into the plenum. ID Ø40 → Ø36. The bellmouth is poor quality (K_in ≈ 0.2). 3D printed.
- **Injector:** 79 mm above the head flange.
- **Head port:** length **unknown**, 80 mm used, and 80–110 mm fit equally well.
- SDM25's intake is **different** and has not been supplied.

**Exhaust (4-2-1):**
- **Pairing:** collectors are **1-4 and 2-3** (confirmed).
- **Primaries:** 312.3 mm from the flange to the first collector start. 1.25 in OD (tube sizes are OD; 0.049 in wall assumed), stepping to 1.5 in at the collector.
- **Collectors:** 106.3 mm long, with the pipes running side by side until they merge 46.6 mm in.
- **Secondaries:** 1.5 in, 467.3 mm from the first collector to the end of the second, read as a 361 mm tube.
- **After the final collector:** 1.5 → 1.75 → 2 in steps plus a ~90° elbow (~300 mm assumed), then a 2 in straight-through muffler, **12 in or 17 in** (12 in used; the result is insensitive).
- **Exhaust port:** 65 mm assumed.

## Real-car reference data (in git now)

`physics_findings/references/ecu/` holds data from ECU log "Log 7.5" (Link G4X, SDM26, 2026-09-07):
- `proxy_lag*.csv`: the WOT VE proxy (PW − 1.0 ms) × λ(t+lag), in 250 rpm bins, for λ lags 0–360 ms. **Use 270 ms**, which is the measured sensor lag.
- `ecu_ve_proxy.csv`: the earlier 120 ms version.
- `sdm26_wot_tune_from_log7.5.csv`: per-rpm WOT median ignition, λ, λ target and MAP. This is the "real tune".
- `scripts/load.py` and `scripts/proxy.py`: these rebuild the above. The raw `Log 7.5.csv` (~98 MB) is **not in git**. It is in the **Helios vault at `SDM27/Helios/Log 7.5.csv`** (on the work machine: `Documents\Vault\SDM27\Helios\Log 7.5.csv`). Get it from the vault, then run `python load.py "<path>\Log 7.5.csv"`.
- Some analysis scripts inside the finding folders still point at the old machine's temp scratchpad. Re-point them at `references/ecu/` if you re-run them.

Car targets: VE peaks ~6.0–6.4k and ~9.0k, troughs ~4.6k and ~7.4–8.0k. Dyno torque: peak 6.0k, dip 6.5–7.5k, peak 8.5k. The true ripple is ~±10%; the proxy overstates it because closed-loop λ trim is pinned at −20% at 5–6.5k and λ floors at ~0.70 at 4.4–5.6k.

The car's tune is poor. λ runs 0.70–1.00 against a 0.88 target, and ignition runs 20.5° at 4k up to 36° at 10k. Judge **geometry by VE vs the ECU proxy**; judge **torque only with the real tune loaded**.

## What's been ruled out as the cause of the missing 7.4–8k trough

- Firing order: 1-2-4-3 is correct.
- Pairing: 1-4 / 2-3 is confirmed.
- Valve lift ±10% and valve Cd.
- Temperatures and wall temps.
- Spark map (no VE effect).
- Delivered vs trapped VE definition.
- Head port 50–110 mm.
- Plenum height ±30%.
- Bellmouth K.
- Muffler 12/17 in, tail length 200–400 mm, exhaust port 40–90 mm, secondary-length readings.
- Numerics.

## Next steps (in order)

1. **Collector modelling.** Collectors are currently lossless point junctions. Model the 46.6 mm side-by-side pre-merge section and a merge loss. This sets how strongly paired exhaust pulses interact, and it's the top remaining suspect.
2. **Bend and perforated-muffler losses.** These cover the long secondary U-bends and the muffler.
3. **Check whether the proxy trough is partly an artefact.** The dyno dip is at 6.5–7.5k and the proxy's at 7.4–8.0k. Get steady-state dyno holds at 6.0/6.5/7.5/8.0/9.0k, or a fast plenum/runner pressure trace.
4. **Skipped item still open:** composition-dependent γ/R in pipes. It needs a variable-γ Riemann solver (a solver-core change), and would move exhaust tuning by ~2–3% in rpm.
5. **Recalibrate** the overall level (η_comb, FMEP, restrictor Cd) against the dyno *with the real tune loaded*, keeping wave knobs (limiter, CFL, reflection coefficients) at physical/neutral values. Owner's rule: every calibration round produces a plot that gets looked at, and a shape regression fails even if RMSE improves.
6. Decide whether to flip the shipped `sdm26.json` to the as-built config (only if it's no worse on dyno RMSE AND better on shape).
7. **Active-runner study:** use `[[sweep.grid]]` in helios-bench to run one sweep per runner length, take the envelope, and pick the switch rpm. Use VE, not torque, as the design metric. Confirm one alternate length on the car or dyno before committing hardware.

## Data the team should collect

- Head intake and exhaust port lengths (flange → valve seat).
- Muffler length (12 or 17 in).
- Runner-length A/B on the dyno: ≥3 lengths, same day and same tune, including 4–6k pulls.
- Fast pressure transducers (plenum + one runner near the port, ≥10 kHz).
- Log IAT, EGT, gear and wheel speed. Turn closed-loop λ trim off at WOT and keep λ above 0.7.

## Running things

```bash
export CARGO_TARGET_DIR=$PWD/target
cargo build --release -p helios-bench
cargo test -p engine-sim -p cfd-core -p helios-bench
./target/release/helios-bench sweep <study.toml> --out out.ndjson   # study examples in physics_findings/*/studies and the finding folders
```

App example configs: `apps/desktop/src-tauri/resources/cfd/configs/`:
- `sdm26_asbuilt.json`
- `sdm26_asbuilt_exhaust.json`
- `sdm26_asbuilt_realtune.json`
- `sdm26-physics-v2.json`
- the sdm25 v2 config
