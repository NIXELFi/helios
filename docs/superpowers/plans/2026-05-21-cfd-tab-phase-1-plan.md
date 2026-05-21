# CFD Tab — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "CFD" tab to the Helios desktop app that loads SDM engine configs from disk, runs a single-RPM 1D-FV simulation in the background with streaming progress + cancellation, renders per-cycle stats, and proves Phase 1 parity with Python via 27 new parity fixtures.

**Architecture:** New `apps/desktop/src/modules/cfd/` React module + `apps/desktop/src-tauri/src/cfd/` Tauri sub-module. Studies-model state machine designed for future sweep/optimization extension. Engine state lives on a worker thread (engine-sim is not Send). Five-event Tauri stream drives the UI. Parity work happens in the engine-sim crate; the desktop crate adds three narrow runner-wrapper tests.

**Tech Stack:** Rust 2024-edition (engine-sim, Tauri), TypeScript + React 18, Vite, Tauri 2, uPlot, vitest, @testing-library/react. Python 3.13 + numpy/scipy/numba (one-time fixture generation only).

**Predecessor spec:** [docs/superpowers/specs/2026-05-21-cfd-tab-phase-1-design.md](../specs/2026-05-21-cfd-tab-phase-1-design.md)

---

## File map (changes locked in here)

### `crates/engine-sim/` — parity expansion

| Path | Action | Responsibility |
|---|---|---|
| `python_ref/scripts/capture_goldens.py` | modify | Add `capture_engine_matrix`, `capture_engine_convergence`, `capture_muscl_extras`, `capture_hllc_extras` functions; wire into `__main__` |
| `fixtures/parity/engine_matrix_<config>_<junction>_<rpm>_5cyc.json` × 20 | create | Per-cycle stats for the 2×2×5 matrix |
| `fixtures/parity/engine_convergence_<config>_25cyc.json` × 2 | create | Long-run convergence verification |
| `fixtures/parity/muscl_<case>.json` × 4 | create | Contact / rarefaction / supersonic / mixed-gamma MUSCL cases |
| `fixtures/parity/hllc_extras.json` | create | 500 random + 8 Toro textbook Riemann problems |
| `tests/parity_engine_matrix.rs` | create | Macro-generated `#[test]` per engine-matrix fixture |
| `tests/parity_engine_convergence.rs` | create | Two convergence tests |
| `tests/parity_solver_extras.rs` | create | Four MUSCL parity tests |
| `tests/parity_hllc_extras.rs` | create | Extended HLLC parity test |

### `apps/desktop/src-tauri/` — Rust commands + runner

| Path | Action | Responsibility |
|---|---|---|
| `Cargo.toml` | modify | Add `engine-sim`, `ulid`, `serde`, `serde_json` deps (most already present); confirm |
| `tauri.conf.json` | modify | Add `bundle.resources` entry for `resources/cfd/configs/*.json` |
| `resources/cfd/configs/sdm25.json` | create (copy) | From `crates/engine-sim/python_ref/configs/sdm25.json` |
| `resources/cfd/configs/sdm26.json` | create (copy) | From `crates/engine-sim/python_ref/configs/sdm26.json` |
| `src/cfd/mod.rs` | create | Module entry; re-export commands + state |
| `src/cfd/dto.rs` | create | All serde DTOs (LoadedConfig, ExampleConfig, StartJobRequest, JobEvent payloads, JobSummary, ConfigSummary) |
| `src/cfd/state.rs` | create | `CfdState`, `JobHandle`, concurrent insert/remove/cancel |
| `src/cfd/runner.rs` | create | `JobEmitter` trait + `run_single_rpm_job` worker function + `DivergenceProbe` test seam |
| `src/cfd/commands.rs` | create | Four `#[tauri::command]` functions + `cfd_list_jobs` |
| `src/cfd/tests/` | create | Unit tests for dto, state, runner |
| `src/lib.rs` | modify | Register `cfd::*` commands; add `.manage(CfdState::default())` |

### `apps/desktop/src/` — React module + tab wiring

| Path | Action | Responsibility |
|---|---|---|
| `shell/ModulePicker.tsx` | modify | Add `"cfd"` to `ModuleId` and a button entry |
| `Shell.tsx` | modify | Mount `<Cfd>` module |
| `modules/cfd/index.tsx` | create | Module entry |
| `modules/cfd/CfdHome.tsx` | create | Owns `CfdContext` provider; NavRail + active screen |
| `modules/cfd/state/CfdContext.tsx` | create | React context: loadedConfig, studies map, activeStudyId, activeScreen, mutators; localStorage I/O |
| `modules/cfd/state/types.ts` | create | All TS types (Study, CycleStats, LoadedConfig, etc.) — single source of truth |
| `modules/cfd/lib/sdm26Schema.ts` | create | SDM26Config field metadata (label, unit, range) — drives summary now, editor later |
| `modules/cfd/lib/cfdStorage.ts` | create | Versioned localStorage I/O |
| `modules/cfd/lib/cfdPath.ts` | create | Basename + tooltip helpers |
| `modules/cfd/lib/tauriBridge.ts` | create | Thin typed wrappers around invoke + listen (so tests can fake the boundary) |
| `modules/cfd/components/NavRail.tsx` | create | Data-driven entries array; renders nav rail |
| `modules/cfd/components/charts/CycleChart.tsx` | create | Generic uPlot wrapper |
| `modules/cfd/components/PathLabel.tsx` | create | Basename display + full-path tooltip |
| `modules/cfd/components/ConfirmModal.tsx` | create | In-app confirm modal (no `window.confirm`) |
| `modules/cfd/screens/ConfigScreen.tsx` | create | Read-only summary + Open/Load Example |
| `modules/cfd/screens/StudiesScreen.tsx` | create | Studies table + New Study kind picker |
| `modules/cfd/screens/ResultsScreen.tsx` | create | Dispatches on `study.kind` |
| `modules/cfd/results/SingleRpmResults.tsx` | create | Phase 1 result renderer |
| `modules/cfd/__tests__/fakes/tauri.ts` | create | `invoke` + `listen` fake |
| `modules/cfd/__tests__/fakes/study.ts` | create | Study / CycleStats / LoadedConfig factories |
| `modules/cfd/__tests__/CfdContext.test.tsx` | create | State machine tests |
| `modules/cfd/__tests__/ConfigScreen.test.tsx` | create | |
| `modules/cfd/__tests__/StudiesScreen.test.tsx` | create | |
| `modules/cfd/__tests__/SingleRpmResults.test.tsx` | create | |
| `modules/cfd/__tests__/NavRail.test.tsx` | create | |

---

## Task ordering & rationale

The plan is split into four logical waves. Within each wave, tasks have strict TDD per file (tests written first, fail, implement, pass, commit).

**Wave A — Parity foundation (engine-sim crate, isolated):**
- Tasks 1–4: Extend Python capture script, run it, generate 27 fixtures, write Rust tests, ensure all 45 parity tests pass.
- Rationale: Independent of UI work; gives confidence the math is rock-solid before building atop it. If anything breaks here, we stop and fix before integration work.

**Wave B — Rust backend (Tauri commands):**
- Tasks 5–10: DTOs → state → runner → commands → register → unit tests.
- Rationale: Frontend will mock these via faked invoke initially; getting them right first means the React side has a real contract to code against.

**Wave C — Frontend (React module):**
- Tasks 11–22: Types → context → lib helpers → charts → screens → tab wiring → tests.
- Rationale: Build inside-out (state machine first, screens last) so each layer can be tested in isolation.

**Wave D — Integration & verification:**
- Tasks 20–22: full test suite, manual smoke gates, branch summary.

---

## Wave A — Parity foundation

### Task 1: Extend `capture_goldens.py` with new capture functions

**Files:**
- Modify: `crates/engine-sim/python_ref/scripts/capture_goldens.py`

- [ ] **Step 1: Read existing capture_goldens.py to understand patterns**

Specifically: how it writes fixture JSON, how it loads configs, how it calls SDM26Engine.

- [ ] **Step 2: Add `capture_engine_matrix()` function**

Iterate 2 configs × 2 junctions × 5 RPMs. For each: load config via `configs.config_loader.load_v1_json`, construct `SDM26Engine(cfg, junction_kind)`, call `eng.run_single_rpm(rpm, n_cycles=5, stop_at_convergence=False, ...)`. Serialize per-cycle stats to `fixtures/parity/engine_matrix_<config>_<junction>_<rpm>_5cyc.json` with the same envelope shape as `engine_5cycle.json`: `{ kernel, inputs, outputs, git_sha, python_version, numpy_version, tolerance }`.

- [ ] **Step 3: Add `capture_engine_convergence()` function**

Two runs: SDM25 + SDM26, both at 6000 RPM, Stagnation junctions, n_cycles_max=25, stop_at_convergence=True. Capture the full per-cycle stats array, the chosen converged_cycle, and the actual n_cycles_run. Output: `engine_convergence_sdm25_25cyc.json`, `engine_convergence_sdm26_25cyc.json`.

- [ ] **Step 4: Add `capture_muscl_extras()` function**

Four initial conditions (contact-discontinuity, left-rarefaction, supersonic-shock, mixed-gamma), each one MUSCL-Hancock step on a 200-cell pipe. Output: `muscl_<case>.json` (4 files). Tolerance: same as existing muscl.json (rtol=1e-10, atol=1e-12).

- [ ] **Step 5: Add `capture_hllc_extras()` function**

500 random Riemann problems (different seed than existing `hllc.json`) + 8 Toro textbook cases (shock-tubes A-E + low-density + slowly-moving-contact + near-vacuum). Output: `hllc_extras.json`. Tolerance: same as existing hllc.json (rtol=1e-12, atol=1e-14).

- [ ] **Step 6: Wire into `__main__`**

Add CLI flags `--matrix`, `--convergence`, `--muscl-extras`, `--hllc-extras`. Default behavior (no flags): run all four. Existing fixtures untouched unless explicitly requested.

- [ ] **Step 7: Commit**

```bash
git add crates/engine-sim/python_ref/scripts/capture_goldens.py
git commit -m "feat(engine-sim/python_ref): extend golden capture for Phase 1 CFD parity matrix"
```

### Task 2: Generate the 27 new fixtures

**Files:**
- Create: 27 JSON files in `crates/engine-sim/fixtures/parity/`

- [ ] **Step 1: Run the extended capture script**

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:USERPROFILE\scoop\apps\mingw\current\bin;$env:USERPROFILE\scoop\apps\llvm\current\bin;$env:PATH"
Set-Location "c:\Users\nmurray\Documents\Helios\crates\engine-sim\python_ref"
python scripts\capture_goldens.py --matrix --convergence --muscl-extras --hllc-extras
```

Expected output: 27 new JSON files in `crates/engine-sim/fixtures/parity/`. Wall time ~30-60 min (engine matrix dominates).

- [ ] **Step 2: Verify fixture count and structure**

```powershell
Get-ChildItem c:\Users\nmurray\Documents\Helios\crates\engine-sim\fixtures\parity\engine_matrix_*.json | Measure-Object | Select-Object Count   # expect 20
Get-ChildItem c:\Users\nmurray\Documents\Helios\crates\engine-sim\fixtures\parity\engine_convergence_*.json | Measure-Object | Select-Object Count  # expect 2
Get-ChildItem c:\Users\nmurray\Documents\Helios\crates\engine-sim\fixtures\parity\muscl_*.json | Measure-Object | Select-Object Count  # expect 4 (plus existing muscl.json)
Get-ChildItem c:\Users\nmurray\Documents\Helios\crates\engine-sim\fixtures\parity\hllc_extras.json   # expect 1
```

- [ ] **Step 3: Commit**

```bash
git add crates/engine-sim/fixtures/parity/
git commit -m "feat(engine-sim): generate 27 new parity fixtures for Phase 1 CFD"
```

### Task 3: Add Rust parity tests for new engine fixtures

**Files:**
- Create: `crates/engine-sim/tests/parity_engine_matrix.rs`
- Create: `crates/engine-sim/tests/parity_engine_convergence.rs`

- [ ] **Step 1: Skim the existing `parity_engine.rs` to match conventions**

Look at how it loads JSON, applies tolerances, asserts CycleStats fields.

- [ ] **Step 2: Write `parity_engine_matrix.rs` with a macro-generated test per fixture**

```rust
// Uses a build.rs-free approach: enumerate fixtures at compile time via a macro
// that lists all (config, junction, rpm) tuples.

macro_rules! engine_matrix_test {
    ($name:ident, $config:literal, $junction:literal, $rpm:literal) => {
        #[test]
        fn $name() {
            let path = format!(
                "fixtures/parity/engine_matrix_{}_{}_{}_5cyc.json",
                $config, $junction, $rpm
            );
            run_engine_parity_fixture(&path);
        }
    };
}

// 20 invocations (2 configs × 2 junctions × 5 RPMs)
engine_matrix_test!(matrix_sdm25_stagnation_4000,        "sdm25", "stagnation",     "4000");
engine_matrix_test!(matrix_sdm25_stagnation_6000,        "sdm25", "stagnation",     "6000");
// ...etc.
```

Helper `run_engine_parity_fixture` lives in a sibling `tests/common/mod.rs` (already exists; extend it).

- [ ] **Step 3: Run the matrix tests**

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:USERPROFILE\scoop\apps\mingw\current\bin;$env:USERPROFILE\scoop\apps\llvm\current\bin;$env:PATH"
Set-Location "c:\Users\nmurray\Documents\Helios"
cargo test -p engine-sim --test parity_engine_matrix
```

Expected: 20 tests pass.

- [ ] **Step 4: Write `parity_engine_convergence.rs`**

Two tests, one per config. Assert per-cycle stats AND `converged_cycle` AND `n_cycles_run` match the fixture.

- [ ] **Step 5: Run convergence tests**

```bash
cargo test -p engine-sim --test parity_engine_convergence
```

Expected: 2 tests pass.

- [ ] **Step 6: Commit**

```bash
git add crates/engine-sim/tests/parity_engine_matrix.rs crates/engine-sim/tests/parity_engine_convergence.rs crates/engine-sim/tests/common/
git commit -m "test(engine-sim): add 22 engine-level parity tests across RPM/config/junction matrix"
```

### Task 4: Add Rust parity tests for extra MUSCL + HLLC fixtures

**Files:**
- Create: `crates/engine-sim/tests/parity_solver_extras.rs`
- Create: `crates/engine-sim/tests/parity_hllc_extras.rs`

- [ ] **Step 1: Write `parity_solver_extras.rs` with 4 MUSCL tests**

One per case (contact, left-rarefaction, supersonic, mixed-gamma). Pattern matches existing `parity_solver.rs`.

- [ ] **Step 2: Write `parity_hllc_extras.rs` with one consolidated test**

Iterates over all 508 (500 random + 8 textbook) Riemann problems in `hllc_extras.json`, asserts each.

- [ ] **Step 3: Run all parity tests**

```bash
cargo test -p engine-sim
```

Expected: 18 existing + 22 new engine + 4 MUSCL + 1 HLLC-extras = 45 tests pass.

- [ ] **Step 4: Commit**

```bash
git add crates/engine-sim/tests/parity_solver_extras.rs crates/engine-sim/tests/parity_hllc_extras.rs
git commit -m "test(engine-sim): add MUSCL + HLLC kernel-level parity extras"
```

---

## Wave B — Rust backend (Tauri commands)

### Task 5: Add `engine-sim` dep + bundled config resources

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Modify: `apps/desktop/src-tauri/tauri.conf.json`
- Create: `apps/desktop/src-tauri/resources/cfd/configs/sdm25.json` (copy)
- Create: `apps/desktop/src-tauri/resources/cfd/configs/sdm26.json` (copy)

- [ ] **Step 1: Add `engine-sim` workspace dep to desktop Cargo.toml**

Add to `[dependencies]`:
```toml
engine-sim = { path = "../../../crates/engine-sim" }
ulid = "1"
```

(serde, serde_json, tauri already present.)

- [ ] **Step 2: Copy bundled configs**

```powershell
New-Item -ItemType Directory -Force -Path "c:\Users\nmurray\Documents\Helios\apps\desktop\src-tauri\resources\cfd\configs" | Out-Null
Copy-Item -Path "c:\Users\nmurray\Documents\Helios\crates\engine-sim\python_ref\configs\sdm25.json" -Destination "c:\Users\nmurray\Documents\Helios\apps\desktop\src-tauri\resources\cfd\configs\sdm25.json"
Copy-Item -Path "c:\Users\nmurray\Documents\Helios\crates\engine-sim\python_ref\configs\sdm26.json" -Destination "c:\Users\nmurray\Documents\Helios\apps\desktop\src-tauri\resources\cfd\configs\sdm26.json"
```

- [ ] **Step 3: Register in `tauri.conf.json` under `bundle.resources`**

Add `"resources/cfd/configs/*.json"` to the resources list.

- [ ] **Step 4: Verify build still works**

```bash
cargo check -p helios-desktop
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/tauri.conf.json apps/desktop/src-tauri/resources/
git commit -m "feat(desktop): bundle SDM25/SDM26 example configs as Tauri resources"
```

### Task 6: Write `cfd::dto` (serde DTOs)

**Files:**
- Create: `apps/desktop/src-tauri/src/cfd/mod.rs`
- Create: `apps/desktop/src-tauri/src/cfd/dto.rs`
- Create: `apps/desktop/src-tauri/src/cfd/tests/dto_test.rs`

- [ ] **Step 1: Sketch `mod.rs`**

```rust
pub mod commands;
pub mod dto;
pub mod runner;
pub mod state;

pub use commands::*;
pub use state::CfdState;
```

(Stubs for now; will be filled in subsequent tasks.)

- [ ] **Step 2: Write `dto.rs` with all serde types**

All DTOs derive `Serialize, Deserialize` and use `#[serde(rename_all = "camelCase")]` so the TS side sees `cycleStats`, `jobId`, etc. All status / kind enums use `#[serde(rename_all = "kebab-case")]` so their string values are `"single-rpm"`, `"running"`, `"solver-diverged"`, etc.

- `LoadedConfig { path: String, cfg: SDM26ConfigDto, summary: ConfigSummary }`
- `SDM26ConfigDto` — flatten via `serde(remote = "engine_sim::model::sdm26::SDM26Config")` if needed, OR a manual mirror struct (preferred for documentation; field set is fixed). Choose manual.
- `ConfigSummary { display_name: String, n_cyl: u32, bore_mm: f64, stroke_mm: f64, cr: f64, /* enough for the summary card header */ }`
- `ExampleConfig { name: String, description: String, path: String }`
- `StartJobRequest` (tagged enum, "kebab-case")
- `SingleRpmParams { rpm: f64, n_cycles_max: u32, junction_kind: JunctionKindDto, convergence_tol_imep: f64, convergence_min_cycles: u32 }`
- `JunctionKindDto { Stagnation, Characteristic }` with `From<JunctionKindDto> for engine_sim::model::sdm26::JunctionKind`
- `StartJobResponse { job_id: String }`
- `JobSummary { id, kind, status, started_at, finished_at }`
- `JobStatus { Running, Done, Cancelled, Error }` (mirrors frontend's StudyStatus minus `idle` and `cancelling` — Rust only emits terminal states + "running")
- `JobEvent` payloads (each as separate struct so emitting is type-safe)
- `CycleStatsDto` — mirrors `engine_sim::CycleStats` field-for-field

- [ ] **Step 3: Write DTO round-trip tests in `tests/dto_test.rs`**

For each tagged enum and each "leaf" DTO, assert serde JSON round-trip is identity.

- [ ] **Step 4: Run dto tests**

```bash
cargo test -p helios-desktop cfd::dto
```

Expected: all DTO tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/cfd/
git commit -m "feat(desktop/cfd): serde DTOs for CFD Tauri command surface"
```

### Task 7: Write `cfd::state` (job registry)

**Files:**
- Create: `apps/desktop/src-tauri/src/cfd/state.rs`
- Create: `apps/desktop/src-tauri/src/cfd/tests/state_test.rs`

- [ ] **Step 1: Write concurrent-map tests first**

`CfdState::default()` is empty. Two threads insert different jobs concurrently → both visible. Cancel sets the cancel flag. Remove drops the entry.

- [ ] **Step 2: Implement `state.rs`**

```rust
pub struct CfdState {
    pub jobs: Mutex<HashMap<JobId, JobHandle>>,
}

pub struct JobHandle {
    pub kind: StudyKind,
    pub status: Arc<Mutex<JobStatus>>,
    pub cancel: Arc<AtomicBool>,
    pub started_at: u64,
    pub finished_at: Arc<Mutex<Option<u64>>>,
    pub config_path: String,
    // joinhandle dropped after thread finishes (we don't join it)
}
```

Provide constructor `JobHandle::new(kind, config_path)` returning the handle + the cancel flag (cloned).

- [ ] **Step 3: Run state tests**

```bash
cargo test -p helios-desktop cfd::state
```

Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/src/cfd/state.rs apps/desktop/src-tauri/src/cfd/tests/state_test.rs
git commit -m "feat(desktop/cfd): CfdState job registry with cancel + status tracking"
```

### Task 8: Write `cfd::runner` (worker thread function)

**Files:**
- Create: `apps/desktop/src-tauri/src/cfd/runner.rs`
- Create: `apps/desktop/src-tauri/src/cfd/tests/runner_test.rs`

- [ ] **Step 1: Define `JobEmitter` and `DivergenceProbe` traits**

```rust
pub trait JobEmitter: Send + 'static {
    fn emit_started(&self, job_id: &str, kind: StudyKind);
    fn emit_progress_single_rpm(&self, job_id: &str, cycle: u32, total: u32, cs: &CycleStats);
    fn emit_done_single_rpm(&self, job_id: &str, summary: SingleRpmSummary);
    fn emit_cancelled(&self, job_id: &str);
    fn emit_error(&self, job_id: &str, reason: ErrorReason, message: String, partial: &[CycleStats]);
}

pub trait DivergenceProbe: Send + 'static {
    fn is_diverged(&self, cs: &CycleStats) -> bool;
}

pub struct DefaultDivergenceProbe;
impl DivergenceProbe for DefaultDivergenceProbe {
    fn is_diverged(&self, cs: &CycleStats) -> bool {
        // any non-finite f64 field in CycleStats means the solver blew up
        !cycle_stats_all_finite(cs)
    }
}
```

Both traits are non-`#[cfg(test)]` so the runner uses the same generic signature in production as in tests; production callers pass `DefaultDivergenceProbe`, test callers pass their own impl.

- [ ] **Step 2: Write runner tests first (happy / cancel / config-load-fail / diverge)**

Use a `VecEmitter { events: Mutex<Vec<RecordedEvent>> }` that captures events. Tests assert the exact sequence.

- [ ] **Step 3: Implement `run_single_rpm_job<E: JobEmitter, P: DivergenceProbe>(...)`**

Body per the spec. Cycle-by-cycle loop, cancel between cycles, `catch_unwind` around the body, divergence probe after each cycle. Production call site (in `commands.rs`) passes `DefaultDivergenceProbe`; tests pass a recording / injection impl.

- [ ] **Step 4: Add `drive_runner_no_emit` helper** (silent runner for the desktop-side parity tests in Task 9)

```rust
pub fn drive_runner_no_emit(cfg: SDM26Config, rpm: f64, n_cycles: u32) -> Vec<CycleStats> { /* uses a NullEmitter */ }
```

- [ ] **Step 5: Run runner tests**

```bash
cargo test -p helios-desktop cfd::runner
```

Expected: all four runner tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/cfd/runner.rs apps/desktop/src-tauri/src/cfd/tests/runner_test.rs
git commit -m "feat(desktop/cfd): worker-thread runner with cancel + divergence probe"
```

### Task 9: Write the three desktop-side parity tests

**Files:**
- Modify: `apps/desktop/src-tauri/src/cfd/tests/runner_test.rs` (add three tests)

- [ ] **Step 1: Test A — runner loop ≡ direct run (Rust↔Rust)**

```rust
#[test]
fn runner_loop_matches_direct_run_sdm26_6000rpm_5cyc() {
    let cfg = engine_sim::config::loader::load_v1_json(
        "../../crates/engine-sim/python_ref/configs/sdm26.json"
    ).unwrap();
    let cycles_runner = drive_runner_no_emit(cfg.clone(), 6000.0, 5);
    let mut eng = SDM26Engine::new(cfg, JunctionKind::Stagnation);
    let r = eng.run_single_rpm(6000.0, 5, false, 1e-3, 5, false);
    assert_eq!(cycles_runner.len(), r.cycle_stats.len());
    for (a, b) in cycles_runner.iter().zip(&r.cycle_stats) {
        assert_close!(a.imep_bar, b.imep_bar, rtol=1e-12, atol=1e-14);
        // ...all fields
    }
}
```

- [ ] **Step 2: Test B — runner ≡ Python golden**

Load `crates/engine-sim/fixtures/parity/engine_5cycle.json`, drive runner with same inputs, assert each cycle matches at rtol=1e-6, atol=1e-9.

- [ ] **Step 3: Test C — CycleStats serde round-trip lossless**

```rust
#[test]
fn cycle_stats_serde_roundtrip_lossless() {
    let cs = sample_cycle_stats();
    let json = serde_json::to_string(&cs).unwrap();
    let cs2: CycleStatsDto = serde_json::from_str(&json).unwrap();
    assert_struct_close!(cs, cs2.into(), rtol=0.0, atol=0.0);
}
```

- [ ] **Step 4: Run the three tests**

```bash
cargo test -p helios-desktop cfd::tests::runner_test::runner_loop_matches_direct_run_sdm26_6000rpm_5cyc cfd::tests::runner_test::runner_matches_python_golden_sdm26_6000rpm_5cyc cfd::tests::runner_test::cycle_stats_serde_roundtrip_lossless
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/cfd/tests/runner_test.rs
git commit -m "test(desktop/cfd): three narrow parity tests guarding the runner wrapper"
```

### Task 10: Write `cfd::commands` (Tauri command surface)

**Files:**
- Create: `apps/desktop/src-tauri/src/cfd/commands.rs`
- Modify: `apps/desktop/src-tauri/src/cfd/mod.rs` (fill in)
- Modify: `apps/desktop/src-tauri/src/lib.rs` (register commands + state)

- [ ] **Step 1: Implement the `TauriJobEmitter` adapter**

A concrete impl of `JobEmitter` that wraps `tauri::Window` and calls `window.emit("cfd:job-*", payload)`.

- [ ] **Step 2: Implement the five commands**

- `cfd_load_config(path)` — calls `engine_sim::config::loader::load_v1_json`, builds `LoadedConfig`.
- `cfd_list_examples(app: AppHandle)` — resolves resource paths via `app.path().resource_dir()`, lists `sdm25.json` + `sdm26.json` with hardcoded names/descriptions.
- `cfd_start_job(window, state, request)` — Rust-side dedup check: if `CfdState.jobs` has a Running job with same kind, return `Err`. Otherwise allocate job_id (ULID), spawn thread, return `{ job_id }`.
- `cfd_cancel_job(state, job_id)` — flip the cancel flag.
- `cfd_list_jobs(state)` — snapshot the registry as `Vec<JobSummary>`.

- [ ] **Step 3: Register in `lib.rs`**

```rust
.manage(cfd::CfdState::default())
.invoke_handler(tauri::generate_handler![
    commands::load_csv::load_csv,
    commands::restart::helios_relaunch,
    get_pending_open_files,
    cfd::cfd_load_config,
    cfd::cfd_list_examples,
    cfd::cfd_start_job,
    cfd::cfd_cancel_job,
    cfd::cfd_list_jobs,
])
```

- [ ] **Step 4: Build the desktop crate end-to-end**

```bash
cargo check -p helios-desktop
cargo test -p helios-desktop cfd::
```

Expected: clean build, all cfd tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/cfd/commands.rs apps/desktop/src-tauri/src/cfd/mod.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop/cfd): five Tauri commands wired with one-job-per-kind gate"
```

---

## Wave C — Frontend (React module)

### Task 11: Write TS types + Tauri bridge

**Files:**
- Create: `apps/desktop/src/modules/cfd/state/types.ts`
- Create: `apps/desktop/src/modules/cfd/lib/tauriBridge.ts`
- Create: `apps/desktop/src/modules/cfd/__tests__/fakes/tauri.ts`

- [ ] **Step 1: Write `types.ts`**

Single source of truth: `Study`, `SingleRpmStudy`, `StudyKind`, `StudyStatus`, `CycleStats`, `LoadedConfig`, `SDM26Config`, `ConfigSummary`, `ExampleConfig`, `JobEvent`s. Field names match the Rust DTOs (camelCase on TS side; serde will need `rename_all = "camelCase"` on Rust DTOs — confirm this in Task 6 if not done).

- [ ] **Step 2: Write `tauriBridge.ts`**

```ts
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export const cfdApi = {
  loadConfig: (path: string) => invoke<LoadedConfig>("cfd_load_config", { path }),
  listExamples: () => invoke<ExampleConfig[]>("cfd_list_examples"),
  startJob: (req: StartJobRequest) => invoke<{ job_id: string }>("cfd_start_job", { request: req }),
  cancelJob: (jobId: string) => invoke<void>("cfd_cancel_job", { jobId }),
  listJobs: () => invoke<JobSummary[]>("cfd_list_jobs"),
};

export function subscribeJobEvents(handler: (e: JobEvent) => void) {
  const window = getCurrentWindow();
  const unsubs = ["cfd:job-started", "cfd:job-progress", "cfd:job-done", "cfd:job-cancelled", "cfd:job-error"]
    .map(name => window.listen(name, (ev) => handler({ kind: name, ...(ev.payload as object) } as JobEvent)));
  return async () => { for (const u of unsubs) (await u)(); };
}
```

- [ ] **Step 3: Write `fakes/tauri.ts` for tests**

```ts
export function makeFakeBridge() {
  const handlers: Record<string, Function> = {};
  const subs = new Set<(e: JobEvent) => void>();
  return {
    bridge: { /* mock implementations */ },
    emit: (event: JobEvent) => subs.forEach(s => s(event)),
    invocations: [] as { command: string; args: any }[],
  };
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/modules/cfd/state/types.ts apps/desktop/src/modules/cfd/lib/tauriBridge.ts apps/desktop/src/modules/cfd/__tests__/fakes/tauri.ts
git commit -m "feat(desktop/cfd): TS types + Tauri bridge + test fakes"
```

### Task 12: Write `CfdContext` state machine

**Files:**
- Create: `apps/desktop/src/modules/cfd/state/CfdContext.tsx`
- Create: `apps/desktop/src/modules/cfd/__tests__/CfdContext.test.tsx`
- Create: `apps/desktop/src/modules/cfd/lib/cfdStorage.ts`
- Create: `apps/desktop/src/modules/cfd/__tests__/fakes/study.ts`

- [ ] **Step 1: Write `study.ts` factories**

`makeStudy(overrides)`, `makeCycleStats(overrides)`, `makeLoadedConfig(overrides)`.

- [ ] **Step 2: Write CfdContext tests first (TDD)**

State transitions: empty → loadConfig sets loadedConfig; startStudy adds pending study → progress events append cycles → done sets status & result; cancel mid-run → cancelling → cancelled on event; error event populates error field; reload + rehydrate restores from `cfd_list_jobs`.

- [ ] **Step 3: Implement `cfdStorage.ts`**

```ts
const KEY = "helios.cfd.v1";
export function load(): { lastConfigPath: string | null; studies: StudyHeader[] } { /* ... */ }
export function save(state: ...): void { /* ... */ }
```

- [ ] **Step 4: Implement `CfdContext.tsx`**

`useReducer`-based context. Reducer takes events from the Tauri bridge + UI actions (loadConfig, navigateTo, etc.). Mounting `<CfdProvider>` calls `subscribeJobEvents` and `cfdApi.listJobs` for rehydration; both wired to dispatch into the reducer.

- [ ] **Step 5: Run context tests**

```bash
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:USERPROFILE\scoop\apps\mingw\current\bin;$env:USERPROFILE\scoop\apps\llvm\current\bin;$env:PATH"
Set-Location "c:\Users\nmurray\Documents\Helios"
pnpm --filter @helios/desktop test cfd/__tests__/CfdContext
```

Expected: all CfdContext tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/modules/cfd/state/ apps/desktop/src/modules/cfd/lib/cfdStorage.ts apps/desktop/src/modules/cfd/__tests__/CfdContext.test.tsx apps/desktop/src/modules/cfd/__tests__/fakes/study.ts
git commit -m "feat(desktop/cfd): CfdContext state machine with localStorage hydration"
```

### Task 13: Schema + helper libs

**Files:**
- Create: `apps/desktop/src/modules/cfd/lib/sdm26Schema.ts`
- Create: `apps/desktop/src/modules/cfd/lib/cfdPath.ts`

- [ ] **Step 1: Define field metadata in `sdm26Schema.ts`**

```ts
type FieldMeta = { key: string; label: string; unit?: string; group: string; format?: (v: number) => string };
export const SDM26_SCHEMA: FieldMeta[] = [
  { key: "bore",    label: "Bore",   unit: "mm",  group: "Engine", format: v => (v * 1000).toFixed(1) },
  { key: "stroke",  label: "Stroke", unit: "mm",  group: "Engine", format: v => (v * 1000).toFixed(1) },
  // ...etc., grouped by Engine / Combustion / Intake / Exhaust / Ambient
];
```

- [ ] **Step 2: Implement `cfdPath.ts`**

`basename(p)`, `displayPath(p, { maxLen })` helpers.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/modules/cfd/lib/sdm26Schema.ts apps/desktop/src/modules/cfd/lib/cfdPath.ts
git commit -m "feat(desktop/cfd): SDM26 schema + path helpers"
```

### Task 14: Shared components — NavRail, PathLabel, ConfirmModal, CycleChart

**Files:**
- Create: `apps/desktop/src/modules/cfd/components/NavRail.tsx`
- Create: `apps/desktop/src/modules/cfd/components/PathLabel.tsx`
- Create: `apps/desktop/src/modules/cfd/components/ConfirmModal.tsx`
- Create: `apps/desktop/src/modules/cfd/components/charts/CycleChart.tsx`
- Create: `apps/desktop/src/modules/cfd/__tests__/NavRail.test.tsx`

- [ ] **Step 1: NavRail.tsx — data-driven entries**

Renders an array of `{ id, label, icon }` entries from a prop or constant. Active entry highlighted. Click invokes onSelect.

- [ ] **Step 2: NavRail tests**

Asserts entries render in declared order; clicking switches active.

- [ ] **Step 3: PathLabel.tsx + ConfirmModal.tsx**

PathLabel: shows basename, full path in tooltip. ConfirmModal: simple in-app modal with title/body/Cancel/Confirm; respects no-browser-dialogs rule.

- [ ] **Step 4: CycleChart.tsx — uPlot wrapper**

```tsx
type CycleChartProps = {
  title: string;
  cycles: CycleStats[];
  series: Array<{ label: string; field: keyof CycleStats; color?: string; axis?: "y" | "y2" }>;
  yScale?: "linear" | "log";
};
```

Lazy-load uPlot; on `cycles` change, call `setData` rather than re-mounting.

- [ ] **Step 5: Run NavRail tests**

```bash
pnpm --filter @helios/desktop test cfd/__tests__/NavRail
```

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/modules/cfd/components/ apps/desktop/src/modules/cfd/__tests__/NavRail.test.tsx
git commit -m "feat(desktop/cfd): NavRail + PathLabel + ConfirmModal + CycleChart components"
```

### Task 15: ConfigScreen

**Files:**
- Create: `apps/desktop/src/modules/cfd/screens/ConfigScreen.tsx`
- Create: `apps/desktop/src/modules/cfd/__tests__/ConfigScreen.test.tsx`

- [ ] **Step 1: Write screen tests (TDD)**

Empty state shows two CTAs. Loaded-config state shows all schema groups. `cfd_load_config` failure shows inline banner with message.

- [ ] **Step 2: Implement ConfigScreen**

Uses `@tauri-apps/plugin-dialog`'s `open()` for the Open… button. Renders the read-only summary by iterating `SDM26_SCHEMA` grouped by `group`.

- [ ] **Step 3: Run tests + commit**

### Task 16: StudiesScreen + kind picker

**Files:**
- Create: `apps/desktop/src/modules/cfd/screens/StudiesScreen.tsx`
- Create: `apps/desktop/src/modules/cfd/__tests__/StudiesScreen.test.tsx`

- [ ] **Step 1: Tests first**

Kind picker enables only Single-RPM (Sweep + Optimization disabled with tooltip). New Single-RPM study calls `cfdApi.startJob({ kind: "single-rpm", configPath, params })`. Cancel calls `cfdApi.cancelJob`. Re-run clones params.

- [ ] **Step 2: Implement the screen**

Table + New Study modal (the kind picker → params form for Single-RPM). Params form has RPM, n_cycles_max, junction toggle, convergence tol, min cycles (with defaults: 6000 / 25 / Stagnation / 1e-3 / 5).

- [ ] **Step 3: Run tests + commit**

### Task 17: ResultsScreen + SingleRpmResults

**Files:**
- Create: `apps/desktop/src/modules/cfd/screens/ResultsScreen.tsx`
- Create: `apps/desktop/src/modules/cfd/results/SingleRpmResults.tsx`
- Create: `apps/desktop/src/modules/cfd/__tests__/SingleRpmResults.test.tsx`

- [ ] **Step 1: Tests first**

Mid-run rendering: cycle counter increments as progress events arrive. Chart's `setData` called on each progress event with the appended cycle. Header recap shows config name + params.

- [ ] **Step 2: Implement ResultsScreen (pure dispatch) + SingleRpmResults**

Three regions per the spec: header strip, 2×2 charts grid, cycle-stats table. Charts use `CycleChart`.

- [ ] **Step 3: Run tests + commit**

### Task 18: CfdHome + module index

**Files:**
- Create: `apps/desktop/src/modules/cfd/CfdHome.tsx`
- Create: `apps/desktop/src/modules/cfd/index.tsx`

- [ ] **Step 1: Implement CfdHome**

Wraps everything in `<CfdProvider>`, renders NavRail + active screen, attaches global event listeners (already done by CfdProvider; CfdHome doesn't add its own).

- [ ] **Step 2: Implement index.tsx**

Re-export `CfdHome as Cfd` for Shell to import.

- [ ] **Step 3: Commit**

### Task 19: Tab wiring — ModulePicker + Shell

**Files:**
- Modify: `apps/desktop/src/shell/ModulePicker.tsx`
- Modify: `apps/desktop/src/Shell.tsx`

- [ ] **Step 1: Add `"cfd"` to `ModuleId` union + button**

Match the existing Vault button styling.

- [ ] **Step 2: Mount the module in Shell**

Add `import { Cfd } from "./modules/cfd"` and a hidden-toggle container alongside Logs/Vault.

- [ ] **Step 3: Run typecheck**

```bash
pnpm --filter @helios/desktop typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/shell/ModulePicker.tsx apps/desktop/src/Shell.tsx
git commit -m "feat(desktop): wire CFD tab into ModulePicker + Shell"
```

---

## Wave D — Verification

### Task 20: Run full test suite

- [ ] **Step 1: Engine-sim**

```bash
cargo test -p engine-sim
```

Expected: 18 existing + 27 new = 45 parity tests pass.

- [ ] **Step 2: Desktop crate**

```bash
cargo test -p helios-desktop cfd::
```

Expected: all DTO/state/runner/parity tests pass.

- [ ] **Step 3: Frontend**

```bash
pnpm --filter @helios/desktop test
```

Expected: all module tests pass.

- [ ] **Step 4: Typecheck**

```bash
pnpm --filter @helios/desktop typecheck
```

Expected: clean.

### Task 21: Manual smoke gate (per the spec's verification section)

Start the dev app:

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:USERPROFILE\scoop\apps\mingw\current\bin;$env:USERPROFILE\scoop\apps\llvm\current\bin;$env:PATH"
Set-Location "c:\Users\nmurray\Documents\Helios"
pnpm dev
```

- [ ] **Smoke 1:** Click the CFD tab. Click Load Example → SDM26. Click New Study… → Single-RPM. RPM 6000, 5 cycles, Stagnation. Start. Watch progress stream. Last cycle's IMEP/BMEP/VE/EGT must match `engine_matrix_sdm26_stagnation_6000_5cyc.json` last entry to displayed precision.

- [ ] **Smoke 2:** Click Load Example → SDM25. Click New Study… → Single-RPM. RPM 10000, 5 cycles, Characteristic. Start. Last cycle's IMEP/BMEP/VE/EGT must match `engine_matrix_sdm25_characteristic_10000_5cyc.json` last entry.

- [ ] **Smoke 3:** Mid-run cancellation. Start a 25-cycle SDM26 run at 6000 RPM. Click Cancel before cycle 10. Status badge flips to "cancelling" then "cancelled". Partial cycles remain visible.

- [ ] **Smoke 4:** Tab persistence. Switch to Logs, then back to CFD. State preserved (no unmount).

### Task 22: Final commit + branch summary

- [ ] **Step 1: Verify clean working tree**

```bash
git status   # expect no untracked except .claude/
```

- [ ] **Step 2: Branch summary**

```bash
git log --oneline origin/main..HEAD
```

Verify the commit chain is clean and each commit message is informative.

---

## Out of scope (explicit) — do NOT do in Phase 1

- Editing configs
- Multi-RPM sweeps
- Saving completed studies to disk
- Per-cylinder P-V loops
- Per-pipe end-of-cycle profiles
- Live per-step flow streaming
- Supabase / auth
- Anything in Phase 2-5 of the spec

If a task starts pulling these in, stop and re-read the spec.

## Notes for the executor

- **TDD per file.** Write the test, run it, see it fail with the expected error, then implement, then watch it pass.
- **Frequent commits.** Each task ends with a commit. Never let a commit span two tasks.
- **Hook failures:** if a pre-commit hook fails, fix the issue and make a new commit — do not amend.
- **No emojis in code or commits.**
- **No window.alert/confirm/prompt anywhere.**
- **No Python files inside apps/ or any Helios path other than `crates/engine-sim/python_ref/`.**
- **If a parity test fails:** stop and investigate. The tolerance is fixed at the spec's level; do not loosen.
- **If `cargo check` is slow:** that's normal on first build. Subsequent builds are fast.
- **Memory check:** the spec is at `docs/superpowers/specs/2026-05-21-cfd-tab-phase-1-design.md`. Cross-reference when in doubt.
