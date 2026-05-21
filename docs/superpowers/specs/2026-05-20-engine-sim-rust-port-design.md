# Engine-Sim Rust Port — Design

**Date:** 2026-05-20
**Status:** executing autonomously per user instruction
**Source repo:** `github.com/NIXELFi/1dFVEngineSolver` at `research/low-rpm-iteration` @ `24ba2f4`
**Target repo:** `github.com/NIXELFi/helios` on branch `feat/engine-sim-rust-port`
**Crate:** `crates/engine-sim/`

## Goal

Port the 1D compressible-flow engine solver from Python (with Numba `@njit`)
to Rust, embedded as a self-contained crate inside the Helios workspace. The
math must remain identical to within machine-precision tolerance.

No Helios UI integration in this iteration — only the math, its tests, and a
parity harness that proves Rust agrees with Python kernel-by-kernel.

## Scope

In scope:

- All of `solver/` (state, HLLC, MUSCL-Hancock, sources)
- All of `cylinder/` (combustion, gas properties, geometry, heat transfer,
  kinematics, valve)
- All of `bcs/` except the deprecated `bcs/junction.py` (kept as historical
  reference; engine model wires `junction_cv` and `junction_characteristic`).
- `models/sdm26.py` engine assembly + `models/sweep.py` sweep driver
- `configs/config_loader.py` JSON loader and the bundled `sdm26.json`
  fixture

Out of scope:

- `diagnostics/` (matplotlib PDFs)
- `viz/` (HTML viewer)
- `audit_fixes/` (historical diagnostic snapshots)
- Helios UI / Tauri command integration

## Definition of "identical math"

Bit-exact agreement across Python (NumPy/Numba) and Rust is unreachable
without rewriting the math libraries on both sides, because of:

- libm divergence (transcendentals differ in the last ULP)
- reduction order under Numba SIMD vs Rust scalar loops
- Numba's free-floating intermediate representations

Operational definition:

| Quantity | Tolerance | Notes |
| --- | --- | --- |
| Per-kernel scalar outputs (`hllc_flux`, `wiebe_xb`, `gamma_burned`, …) | `rtol = 1e-12, atol = 1e-14` | exact to last 1-2 ULP |
| Per-kernel array outputs (`muscl_hancock_step`, `apply_sources`) | `rtol = 1e-10, atol = 1e-12` | accumulated drift from per-element scalar ops |
| Engine-level cycle stats (IMEP, VE, EGT, brake torque after `n` cycles) | `rtol = 1e-6, atol = 1e-9` | accumulated over millions of steps; the engineering match is much tighter than measurement noise |

To stay near the tight end of these bands, the port follows these rules:

1. `f64` throughout (matches NumPy `float64`).
2. Scalar loops over `Vec<f64>` — no `ndarray`, no SIMD intrinsics, no rayon
   parallel reductions where ordering matters.
3. No fused multiply-add (`f64::mul_add`) anywhere.
4. Standard library transcendentals (`f64::sqrt`, `f64::powf`, `f64::sin`,
   `f64::exp`, …) — last-ULP libm drift is the only accepted concession.
5. Expression order matches Python verbatim, even when an algebraic
   simplification would be more elegant in Rust.
6. No fast-math compiler flags. Rust default codegen is IEEE-754; we keep
   it that way.

## Crate layout

```
crates/engine-sim/
├── Cargo.toml
├── src/
│   ├── lib.rs                       — public re-exports
│   ├── solver/
│   │   ├── mod.rs
│   │   ├── state.rs                 — PipeState, make_pipe_state, set_uniform, primitives
│   │   ├── hllc.rs                  — hllc_flux, euler_flux, prim_to_cons, cons_to_prim
│   │   ├── muscl.rs                 — muscl_hancock_step, limiters, cfl_dt
│   │   └── sources.rs               — apply_sources, blasius, dittus_boelter, strang_split_step
│   ├── cylinder/
│   │   ├── mod.rs
│   │   ├── gas_properties.rs        — gamma_unburned/burned/mixture, R_mixture, speed_of_sound
│   │   ├── geometry.rs              — volume, dVdtheta, surface_area
│   │   ├── kinematics.rs            — omega_from_rpm, cylinder_phase_offsets
│   │   ├── combustion.rs            — WiebeParams, wiebe_xb, wiebe_burn_rate, is_combusting
│   │   ├── heat_transfer.rs         — WoschniParams, woschni_h, woschni_dQdt
│   │   ├── valve.rs                 — ValveParams, valve_lift, valve_Cd, valve_effective_area
│   │   └── cylinder.rs              — CylinderGeom, CylinderState, CylinderModel::advance
│   ├── bcs/
│   │   ├── mod.rs
│   │   ├── simple.rs                — transmissive + reflective ghost fills
│   │   ├── subsonic.rs              — fill_subsonic_inflow_left*, fill_subsonic_outflow_right
│   │   ├── restrictor.rs            — fill_choked_restrictor_left, restrictor_mdot
│   │   ├── junction_cv.rs           — JunctionCV (stagnation CV)
│   │   ├── junction_characteristic.rs — CharacteristicJunction (Newton + characteristic + Picard)
│   │   └── valve.rs                 — ValveBC, fill_valve_ghost*, all five regime branches
│   ├── model/
│   │   ├── mod.rs
│   │   ├── sdm26.rs                 — SDM26Config, SDM26Engine, linear_diameter_area, validation
│   │   └── sweep.rs                 — run_sweep with IMEP convergence
│   └── config/
│       ├── mod.rs
│       └── loader.rs                — load_v1_json
├── tests/                           — Rust integration tests
│   └── parity/                      — fixture-driven parity tests vs Python goldens
├── fixtures/
│   └── parity/                      — committed Python golden outputs (JSON)
├── python_ref/
│   ├── scripts/
│   │   └── capture_goldens.py       — driver that produces fixtures/parity/*.json
│   └── README.md                    — how to regenerate fixtures
└── README.md
```

## Type design

### `PipeState`

Python's `PipeState` is a dataclass plus a runtime-attached `_scratch` dict.
Rust splits these:

```rust
pub struct PipeState {
    pub q: Vec<f64>,             // (n_total * 4) flat, conservative
    pub area: Vec<f64>,          // n_total
    pub area_f: Vec<f64>,        // n_total + 1
    pub hydraulic_d: Vec<f64>,   // n_total
    pub dx: f64,
    pub n_cells: usize,
    pub n_ghost: usize,
    pub gamma: f64,
    pub r_gas: f64,
    pub wall_t: f64,
}

pub struct ScratchBuffers {
    pub w:        Vec<f64>,   // (n_total * 4)
    pub slopes:   Vec<f64>,
    pub w_pred_l: Vec<f64>,
    pub w_pred_r: Vec<f64>,
    pub flux:     Vec<f64>,   // ((n_total + 1) * 4)
}
```

`q[i, k]` in Python becomes `q[i * N_VARS + k]` in Rust, with constants
`I_RHO_A=0, I_MOM_A=1, I_E_A=2, I_Y_A=3` matching Python.

### Junctions

Both junction types implement a common trait:

```rust
pub trait Junction {
    fn fill_ghosts(&mut self, pipes: &mut [PipeState], dt: f64);
    fn absorb_fluxes(&mut self, pipes: &mut [PipeState], scratches: &[ScratchBuffers], dt: f64);
}
```

Legs hold indices into the engine's pipe vector rather than references —
avoids lifetime entanglement. Engine model owns `Vec<PipeState>` and a
parallel `Vec<ScratchBuffers>`.

### Cylinder

`CylinderModel::advance(theta_global, dtheta, rpm, dt)` mirrors Python
verbatim, including the gas-exchange Euler branch and the closed-cycle
RK4-on-`p(θ)` branch.

## Parity harness

### Capture (Python)

`python_ref/scripts/capture_goldens.py` enumerates kernels and engine
runs, writes one JSON file per fixture into `fixtures/parity/`. Each file
contains:

```json
{
  "kernel": "hllc_flux",
  "inputs": {...},
  "outputs": {"flux": [...]},
  "git_sha": "24ba2f4",
  "python_version": "...",
  "numpy_version": "...",
  "tolerance": {"rtol": 1e-12, "atol": 1e-14}
}
```

Kernels captured (in order of porting):

1. `gas_properties`: γ(T) curves over a dense T grid + R_mixture sweep
2. `geometry`: V(θ), dV/dθ, A_surface(θ) over a CA sweep
3. `kinematics`: omega_from_rpm, phase_offsets
4. `combustion`: Wiebe xb and burn rate over CA sweep
5. `heat_transfer`: woschni_h on a grid of (p, T, V) states
6. `valve` (cylinder): lift, Cd, effective area over CA sweep
7. `solver/state`: make_pipe_state + set_uniform produces expected arrays
8. `solver/hllc`: hllc_flux on 200 random Riemann problems
9. `solver/muscl`: one MUSCL-Hancock step on a Sod-like initial condition
10. `solver/sources`: apply_sources on a uniform pipe + driven case
11. `bcs/simple, restrictor, subsonic`: each ghost fill on a known interior
12. `bcs/junction_cv`: full lifecycle on a 3-pipe junction
13. `bcs/junction_characteristic`: same 3-pipe junction, all regimes
14. `bcs/valve`: each of the 5 regimes (startup, subsonic_inflow,
    subsonic_outflow, choked_inflow, choked_outflow)
15. `cylinder`: 1-cycle advance with prescribed valve fluxes
16. `engine`: 5-cycle SDM26 run at 6000 RPM, dump every cycle's stats

### Verify (Rust)

`tests/parity/` contains one `#[test]` per fixture. Each loads the JSON,
re-runs the Rust kernel on the same inputs, asserts `assert_close` with
the fixture's declared tolerance.

## Out-of-order things worth flagging

- `bcs/junction.py` (the original Phase-3 draft) is **not** ported.
  `sdm26.py` doesn't import it; only `junction_cv` and
  `junction_characteristic` are wired in. Skipping per its docstring.
- `bcs/valve.py` has back-compat shims (`enable_kickstart_logging`) that
  the model code doesn't use. Skipping unless they appear in tests.
- The Python regime-logging globals in `bcs/valve.py` are diagnostic and
  not part of the math. Rust will expose them via an opt-in `RegimeLog`
  passed by the model only when debugging is needed.

## Execution order

1. Scaffold crate + Cargo manifests + golden-capture skeleton ✅
2. Write `capture_goldens.py` and run it once to populate
   `fixtures/parity/*.json` from the pinned Python tree
3. Port leaf kernels (no internal deps):
   - `solver/state.rs`
   - `cylinder/gas_properties.rs`, `geometry.rs`, `kinematics.rs`
   - `cylinder/combustion.rs`, `heat_transfer.rs`, `valve.rs`
4. Port `solver/hllc.rs`, `solver/muscl.rs`, `solver/sources.rs`
5. Port `bcs/simple.rs`, `restrictor.rs`, `subsonic.rs`
6. Port `bcs/junction_cv.rs`
7. Port `bcs/junction_characteristic.rs` (depends on `solver/hllc.rs`)
8. Port `bcs/valve.rs`
9. Port `cylinder/cylinder.rs`
10. Port `model/sdm26.rs`, `model/sweep.rs`, `config/loader.rs`
11. Engine-level parity test

Each step gates on its kernel-level parity test passing before moving on.
