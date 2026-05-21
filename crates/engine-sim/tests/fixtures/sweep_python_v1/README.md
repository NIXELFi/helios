# Python sweep parity fixture — SDM26 characteristic

Captured from a live Python sweep on 2026-05-21 using
`audit_fixes/sweep_sdm26_export.py` against the canonical
`1dFVEngineSolver` repo at SHA `24ba2f41cff8b47a8829d7ba7e4f1299de97ef27`
on branch `research/low-rpm-iteration`.

Params:
- config:                 configs/sdm26.json (byte-identical to the
                          Rust port's `python_ref/configs/sdm26.json`)
- junction:               characteristic
- rpm_list:               4000, 4500, ..., 15000 (23 points)
- n_cycles_max:           40
- convergence_tol_imep:   0.005
- convergence_min_cycles: 8

Fixture: `sdm26_characteristic_4k_to_15k.csv` — full-precision Python
output. Loaded by `tests/parity_sweep_full_sdm26.rs`.

If a future Python or Rust change breaks parity against this CSV, the
test fails loudly. Re-capture only if the underlying physics has been
intentionally changed in BOTH places.
