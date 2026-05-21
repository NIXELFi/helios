# engine-sim

Rust port of the 1D finite-volume engine cycle simulator at
`github.com/NIXELFi/1dFVEngineSolver` (research/low-rpm-iteration @ 24ba2f4).

The math is held to per-kernel numerical parity with the Python reference;
see `docs/superpowers/specs/2026-05-20-engine-sim-rust-port-design.md` for
the tolerance policy and porting rules.

This crate is **math only** — there is no UI integration with the rest of
Helios. The crate exists so that future Helios features can call into it
without spawning a Python subprocess.

## Layout

- `src/solver/` — pipe state, HLLC Riemann solver, MUSCL-Hancock,
  friction + wall heat source terms.
- `src/cylinder/` — combustion (Wiebe), gas properties (NASA-7 γ),
  geometry, kinematics, valve (lift / Cd / effective area),
  in-cylinder 0D integrator (cylinder.rs).
- `src/bcs/` — boundary conditions: restrictor, valves, junctions
  (stagnation CV + characteristic), simple + subsonic ghost fills.
- `src/model/` — full engine assembly (`SDM26Engine`) and RPM sweep
  driver.
- `src/config/` — V1-compatible JSON config loader.

## Parity

The pinned Python tree is at `python_ref/`. To regenerate the JSON
golden fixtures consumed by `tests/parity/*`:

```bash
cd python_ref
python scripts/capture_goldens.py
```

That writes one JSON file per kernel to `fixtures/parity/`. The Rust
parity tests load those fixtures and assert kernel-level agreement.

## Status

Active port. See parent-repo branch `feat/engine-sim-rust-port`.
