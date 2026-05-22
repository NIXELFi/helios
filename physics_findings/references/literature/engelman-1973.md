# Engelman 1973 — Design of a Tuned Intake Manifold

## Citation

- **Engelman, H. W.** "Design of a Tuned Intake Manifold." ASME paper 73-WA/DGP-2,
  presented at the Winter Annual Meeting, Detroit, MI, November 1973.
- Often cited shorthand: "Engelman tuning length" or "Helmholtz / Engelman runner".
- Republished and widely paraphrased in textbooks: Heywood §6.4, Lumley Ch 6.

## Scope

Engelman applied classical Helmholtz-resonator theory to the intake runner of
a single-cylinder engine, deriving a closed-form expression for the runner
length that maximizes volumetric efficiency at a given target RPM. The result
underpins the design of every "tuned" intake on a high-performance NA SI
engine since.

## Equations

### Eq. 1 — Helmholtz resonator frequency (classical, restated)

```
f_H = (c / (2π)) · sqrt(A_p / (V · L_eff))
```

Where:

| Symbol  | Meaning                                       |
|---------|-----------------------------------------------|
| c       | speed of sound in the runner gas              |
| A_p     | runner cross-sectional area                   |
| V       | cylinder + runner volume at IVO               |
| L_eff   | effective runner length (geometric + end-corr) |

### Eq. 2 — Engine breathing frequency

```
f_engine = N · n_cyl / (2 · 60)    [for 4-stroke; n_cyl per single runner]
```

For a single-cylinder feeding one runner, f_engine [Hz] = RPM / 120.

### Eq. 3 — Engelman tuning criterion (paper eq. 7)

The intake is "tuned" to RPM target when the Helmholtz frequency equals an
integer multiple of the engine breathing frequency. The strongest peak is at
the first harmonic (n=1):

```
f_H = 2 · f_engine    [empirical Engelman ratio for max VE peak]
```

Substituting and solving for L_eff:

```
L_eff = (c² · A_p) / (V · (2 · f_engine · 2π)²)
       = (c² · A_p · 3600) / (V · ω²)        with ω in rad/s
```

Or in engine-friendly form:

```
L_eff [m] ≈ (c · 30) / (RPM · sqrt(V / A_p))   [Engelman tuning eq. simplified]
```

For a target tuning RPM of 9000 with c ≈ 343 m/s, V ≈ 200 cm³, A_p ≈ 8 cm²:

```
L_eff ≈ (343 · 30) / (9000 · sqrt(200/8))
      = 10290 / (9000 · 5.0)
      ≈ 0.23 m
```

Real tuned runners for CBR600-class engines are ~0.30-0.40 m (per
physics_synthesis.md and FSAE published designs). The 0.30 m the Helios race
calibration uses tunes to ~6500 RPM by this formula — slightly below the
peak-power RPM, which is the classical "broad band" trade-off.

### Eq. 4 — End correction for an open-ended pipe

(Engelman §3.)

```
L_eff = L_geometric + 0.6 · r_p
```

Where `r_p` is the pipe radius. For a typical 30 mm-diameter runner, end
correction is ~9 mm — a small but non-negligible contribution to L_eff.

### Eq. 5 — Multi-pulse (acoustic) tuning — beyond Engelman

Engelman 1973 treats only the Helmholtz mode. Modern 1D engine codes (including
Helios) also resolve the *wave-acoustic* mode — pressure pulses propagating up
the runner during IVO and reflecting at the open end. This requires a 1D Euler
solver (Helios has this; see `crates/engine-sim/src/solver/`).

The classical wave-tuning formula (Heywood eq. 6.16):

```
L_wave [m] = (c · t_open) / 2 · (1/n)    n = 1, 2, 3, ...   [harmonic]
```

Where `t_open` is the intake-open duration (s). For a 220° IVO at 9000 RPM:

```
t_open = (220/360) · (60/9000) = 4.07 ms
L_wave (n=1) = (343 · 0.00407) / 2 ≈ 0.70 m   [too long for a real intake]
L_wave (n=2) = 0.35 m                          [matches real designs]
```

So real engines use the *second* harmonic of the wave-acoustic mode, which is
close to Engelman's Helmholtz prediction by coincidence at typical RPM ranges.
Helios's 1D solver resolves both modes simultaneously.

## Constants / coefficients

| Constant       | Value             | Source                  |
|----------------|-------------------|-------------------------|
| End correction | 0.6 · r_p         | Engelman §3 / Beranek 1986 |
| Tuning ratio   | f_H / f_engine = 2 (first harmonic) | Engelman eq. 7 |
| Sound speed (300 K air) | 347 m/s   | tabulated               |
| Sound speed (350 K hot intake) | 374 m/s | scaled √T          |

## Expected ranges (what the solver should produce)

For the Helios SDM26 baseline at the FSAE race calibration (4-cyl, 0.30 m
runner, target tuning RPM ≈ 7000-9000):

- **η_v peak vs runner length sweep:** strongest peak when L_eff matches eq. 3
  for the target RPM. Helios's runner-length sweep in physics_synthesis.md
  shows peak-VE-vs-1/RPM scaling, consistent with Engelman.
- **η_v at 9000 RPM with L=0.30 m**: 0.92-0.96 expected (peak tuning).
- **η_v at 12000 RPM with L=0.30 m**: 0.85-0.92 (off-peak, broader-band tuning).
- **η_v at 6000 RPM with L=0.30 m**: 0.85-0.92 (off-peak in the other direction).

### Sound speed sensitivity

A 10 % change in c (e.g., from charge cooling) shifts the optimal L by 10 %.
Helios's exhaust-driven hot-runner case (T_intake ≈ 380 K vs 300 K reference)
will tune at L ≈ 0.34 m instead of 0.30 m. The solver captures this via
local-gas-state-dependent acoustics.

## Known disagreements

- **Engelman ratio 2 vs 1.5 vs other:** Engelman 1973 gives 2; some
  practical-shop guides give 1.5 or 1.8 based on empirical engine-build
  experience. The difference is ~10-15 % in L. Heywood §6.4 cites Engelman
  but notes "exact ratio depends on cam timing and intake geometry".
- **End correction:** 0.6·r_p is for a flange-mounted open end; for a flush
  (no flange) end the value is ~0.85·r_p. The CBR600 uses flange-mounted
  trumpets, so 0.6 is appropriate.
- **Helmholtz vs wave-acoustic:** Engelman is purely Helmholtz (V/L_eff model).
  Wave-acoustic adds *additional* peaks at L = c·t_open/2n. At typical
  engine geometries these accidentally coincide near the same L; they are
  separable in principle but rarely measured separately. Helios's 1D Euler
  solver resolves both.
- **Multi-cylinder coupling:** Engelman is single-cylinder. For 4-cyl
  manifolds with shared plenums (4-into-1 collectors), the runner length to
  use is per-runner-from-cylinder-to-plenum, not the geometric total. Helios
  models the plenum explicitly so this is automatic.

## Solver implementation notes

- Helios resolves intake acoustics via the 1D Euler solver in
  `crates/engine-sim/src/intake.rs` and the connected runner geometry.
- The Engelman formula is NOT explicitly coded — the simulator solves the
  full acoustic problem. Engelman's prediction is the *expected outcome* the
  solver should approximately reproduce when sweeping L_intake at fixed RPM.
- Phase 1 finding #16 (exhaust-pulse reflection magnitude + junction acoustic
  impedance) is the analog open investigation for the exhaust side.

## Cross-references

- Heywood §6.4 — restated tuning theory.
- Lumley Ch 6 — turbulence-modified acoustic tuning.
- physics_synthesis.md §2.4 — VE peak vs runner length results.
- Phase 1 investigation queue #16.
