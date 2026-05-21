# Python reference (pinned 1d_v2 snapshot)

Frozen copy of `github.com/NIXELFi/1dFVEngineSolver` at
`research/low-rpm-iteration` @ `24ba2f4` (2026-05-20). This is the
exact tree the Rust port targets — every parity test in
`../tests/parity/` compares Rust output against goldens captured from
this Python code.

**Do not edit this directory.** Re-pin by copying a new snapshot from
the upstream repo and updating `PINNED_SHA`. The math change moves the
Rust port off-target; keep the snapshot in lockstep with intentional
re-pins only.

## Layout

Mirrors the upstream repo:

- `solver/`, `cylinder/`, `bcs/`, `models/`, `configs/` — math source
- `scripts/capture_goldens.py` — driver that emits
  `../fixtures/parity/*.json` for the Rust tests to load.

## Regenerating goldens

```bash
cd python_ref
pip install -r requirements.txt   # one-time
python scripts/capture_goldens.py
```

Output lands in `../fixtures/parity/*.json`. Commit the regenerated
fixtures alongside the corresponding Rust changes so reviewers can see
which side moved.
