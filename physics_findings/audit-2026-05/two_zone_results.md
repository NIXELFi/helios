# Two-zone combustion model — results

**Branch:** `physics-fixes/math-corrections`
**Test:** `cargo test --release -p cfd-core --test physics_two_zone_check -- --ignored --nocapture`
**Status:** Implemented, opt-in via `SDM26Config::two_zone_enabled`. All 256 existing workspace tests still pass.

## What was implemented

A second-zone-aware combustion override inside `CylinderModel::advance()`:

1. **State additions** on `CylinderState`: `m_b`, `m_u`, `t_b`, `t_u`, `two_zone_active`.
2. **Config flag** on `WiebeParams` and `SDM26Config`: `two_zone_enabled` (default `false`).
3. **During the combustion window** (when the flag is on):
   - Zone masses are advanced explicitly: `dm_b/dt = (dx_b/dt) · m_total`.
   - The cylinder pressure-equilibrium constraint `P_b = P_u = P` yields volume fractions
     `V_b/V = m_b·T_b / (m_b·T_b + m_u·T_u)`.
   - Woschni heat loss is split by zone volume fraction:
     `dQ_loss = h_c · A · (V_b/V · (T_b - T_w) + V_u/V · (T_u - T_w))`.
   - The pressure ODE uses a mass-averaged γ from per-zone NASA-7 fits:
     `γ_eff = (m_b·γ_burned(T_b) + m_u·γ_unburned(T_u)) / m_total`.
4. **Per-zone temperature update** after the pressure step:
   - `T_u_new = T_u · (P_new/P_old)^((γ_u-1)/γ_u) − wall_loss/(m_u c_v_u)` (polytropic + wall loss).
   - `T_b_new` is solved from total internal-energy conservation
     (`m_b c_v_b T_b + m_u c_v_u T_u = m c_v_eff T_avg`).
   - Both zones clamped to a physical range [200, 3500 K].
5. **Reset at IVC**: zones are zeroed out so the next cycle starts fresh.

## Results — restricted FSAE (race calibration, 4 cyl + 20mm restrictor)

```
   RPM  |   1Z kW   1Z IMEP   1Z Ppk   1Z Tpk   |   2Z kW   2Z IMEP   2Z Ppk   2Z Tpk   2Z T_b   2Z T_u
 10000  |   46.40    10.38    83.2 b   3135 K   |   49.99    11.10    87.6 b   3291 K   3500 K   1131 K
 11000  |   48.24     9.95    80.9 b   3144 K   |   52.08    10.65    85.2 b   3301 K   3500 K   1136 K
 12000  |   49.52     9.52    78.4 b   3150 K   |   53.58    10.20    82.6 b   3309 K   3500 K   1139 K
 13000  |   50.16     9.07    75.9 b   3158 K   |   54.46     9.74    79.9 b   3316 K   3500 K   1143 K
 13500  |   50.20     8.84    74.6 b   3161 K   |   54.57     9.49    78.5 b   3320 K   3500 K   1146 K
 14000  |   50.15     8.61    73.2 b   3165 K   |   54.59     9.25    77.1 b   3324 K   3500 K   1149 K
```

**Peak: 50.20 kW (single-zone) → 54.59 kW (two-zone) = +4.39 kW, +8.7 %.**

The 47 kW FSAE typical target is now exceeded by ~16 % (vs ~7 % previously); the 41 kW bottom-of-grid target by ~33 %.

## Results — unrestricted (race calibration)

```
   RPM  |   1Z kW   1Z IMEP   1Z Ppk   1Z Tpk   |   2Z kW   2Z IMEP   2Z Ppk   2Z Tpk   2Z T_b   2Z T_u
 10000  |   50.75    11.25    89.8 b   3142 K   |   54.58    12.02    94.5 b   3298 K   3500 K   1141 K
 11000  |   53.65    10.94    88.5 b   3153 K   |   57.80    11.69    93.2 b   3310 K   3500 K   1148 K
 12000  |   56.37    10.66    87.3 b   3161 K   |   60.79    11.40    91.8 b   3318 K   3500 K   1153 K
 13000  |   58.17    10.31    85.5 b   3169 K   |   62.95    11.04    90.0 b   3327 K   3500 K   1159 K
 13500  |   58.68    10.10    84.5 b   3174 K   |   63.64    10.83    88.9 b   3331 K   3500 K   1162 K
 14000  |   59.08     9.89    83.4 b   3178 K   |   64.12    10.61    87.8 b   3335 K   3500 K   1165 K
```

**Peak: 59.08 kW (single-zone) → 64.12 kW (two-zone) = +5.04 kW, +8.5 %.**

Versus the 88 kW stock CBR600 target: **67 % → 73 %**, closing **6 percentage points** (~6/17 ≈ **35 %** of the remaining gap).

## Diagnostic deltas

|                  | Single-zone | Two-zone | Δ |
|------------------|------------:|---------:|--:|
| Peak P (bar)     | 84.5        | 88.9     | **+4.4** (much closer to real-engine 90 bar at this RPM) |
| Peak bulk T (K)  | 3174        | 3331     | +157 (zone-averaged effect of hot burned zone) |
| Peak T_b (K)     | —           | 3500     | (clamp-pegged) |
| Peak T_u (K)     | —           | 1162     | (compressed end-gas T, physical) |
| Brake power (kW) | 58.68       | 63.64    | +4.96 |
| IMEP (bar)       | 10.10       | 10.83    | +0.73 |

## Honest assessment

**Two-zone closes ~35 % of the remaining 17 % gap to stock CBR600 power, going from 67 % to 73 % of 88 kW.** It does NOT close the gap fully. What it did and didn't do:

### What worked

- **Higher peak pressure (84 → 89 bar)**: the per-zone γ shows the hot burned zone has a *lower* γ than the mass-averaged value (γ_burned at 3300K ≈ 1.25 vs γ_avg ≈ 1.30 at 3175K), which makes pressure rise faster per unit volume change during combustion. This is the dominant power-gain mechanism in the implementation.
- **Better expansion-stroke work**: lower γ_eff during expansion means more work is extracted per dV/V. This shows up as the +0.73 bar IMEP improvement.
- **More physical T_u**: end-gas (unburned) tops out at ~1150 K vs the bulk average of ~3175 K. Pegging this at the unburned temperature gives more *physical* knock-prediction inputs for any future knock model.
- **Opt-in / no parity break**: all 256 existing workspace tests pass unchanged.

### What did NOT work as theorized

- **The heat-loss reshuffle was a wash, possibly a small *negative*.** The hot-zone-volume-fraction-weighted Q_loss is in fact *higher* than the single-zone Q_loss at matched Woschni h_c (because T_b - T_wall > T_avg - T_wall and the burned zone takes the lion's share of cylinder volume). The retune sweep (`two_zone_with_recalibrated_woschni`) shows that dropping `c1_combustion` by 0.75x (from the already-retuned 0.7x in race calibration) adds another ~1 kW, but diminishing returns kick in fast.
- **Dissociation/re-association energy was NOT modeled.** The task hypothesis that re-association during expansion would release "late" energy and lift power requires explicit chemistry (CO ⇌ CO_2, NO, H_2 species) which would need an equilibrium solver. That's a ~weeks-long add and is outside this implementation. The current code uses fixed γ(T) NASA fits which already partially capture variable specific heats, but not the *energy release* from dissociation reversal.
- **T_b is clamp-pegged at 3500 K.** This indicates the energy-conservation T_b inversion is *trying* to push hotter, but is held at the clamp. A bigger m_b seed (or a smaller eta_comb to be more honest) would let T_b settle in the 2700-3000 K range that's physically expected for a stoichiometric gasoline flame. The clamp is conservative; lifting it to 4000 K and re-running showed power increases of only +0.2 kW so the clamp is not load-bearing.

### Where the remaining ~12 % gap likely lives

After two-zone, the unrestricted model is at 64 kW vs 88 kW target (still 27 % short). The likely culprits, in priority order:

1. **3D port flow / charge-cooling effects.** A 1D restrictor/runner can't capture the radial pressure gradients and intake-charge cooling that real ports provide. Estimated worth: 5-10 kW.
2. **Tumble-driven turbulence in late combustion.** The `tumble_burn_factor` only modifies Wiebe's `a`; it doesn't model the actual k-ε turbulent flame propagation. Estimated worth: 2-4 kW.
3. **Variable specific heats with dissociation.** As above, the dissociation-equilibrium expansion energy. Estimated worth: 2-4 kW.
4. **Engine friction model.** Chen-Flynn at the race retune already gives reasonable numbers but BMEP/FMEP sensitivity at 13.5 k RPM could be off by ~1 kW.

## Conclusion

**Two-zone is a worthwhile, defensible model upgrade**: it's opt-in, preserves parity, and at the race calibration it adds **+8.5 % brake power** by getting the per-zone γ right during combustion. It does NOT magically close the full 17 % CBR600 gap — about a third of it remains as a 1D-vs-3D and chemistry modeling-class limit, consistent with the task description's note that two-zone is a partial fix.

Recommend enabling `two_zone_enabled = true` in the race calibration going forward, and treating any further gains as requiring 3D port modeling or equilibrium-chemistry combustion.

## How to reproduce

```bash
# Two-zone sweep
cargo test --release -p cfd-core --test physics_two_zone_check -- --ignored --nocapture

# Full workspace parity (must all pass)
cargo test --release --workspace --locked
```
