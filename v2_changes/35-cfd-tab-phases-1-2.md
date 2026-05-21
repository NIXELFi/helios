# 35 — CFD tab (Phases 1 + 2)

## Phase 1 — Tab scaffold + single-RPM runner

**What landed:** A new "CFD" top-level tab next to Logs and Vault,
matching their density and chrome (10-11px small-caps gold headers,
`#0E0E10` / `#0B0B0D` / `#16171B` / `#2A2C32` surfaces, `#FFC627`
accents). Three internal screens via a data-driven NavRail: Config
(read-only summary in Phase 1, editor in Phase 2), Studies (table +
"New study…" kind picker), Results (per-study renderer).

**Architecture:**
- New workspace crate `crates/cfd-core/` holding pure DTOs + job
  registry + worker-thread runner, carved out so unit tests run
  without Tauri's runtime DLL footprint (GNU+Windows can't load
  WebView2Loader.dll inside the desktop lib's test binary).
- Five Tauri commands (`cfd_load_config`, `cfd_list_examples`,
  `cfd_start_job`, `cfd_cancel_job`, `cfd_list_jobs`) and a
  five-event stream (`cfd:job-{started,progress,done,cancelled,error}`).
- Studies-model state machine on the frontend with `kind:
  "single-rpm"` discriminator — extensible to sweep / optimization
  in later phases without restructuring.
- Engine-sim gains a publicly-drivable `advance_one_cycle` /
  `CycleLoopState` API; `run_single_rpm` now delegates to it so the
  runner's cycle-by-cycle progress streaming produces bit-identical
  results to a single multi-cycle call.

**Parity:** 27 new fixtures + tests in `crates/engine-sim/` (20
matrix: 2 configs × 2 junctions × 5 RPMs; 2 long-run convergence;
4 MUSCL extras; 1 HLLC extras with 508 cases). Tolerances held at
the existing rtol=1e-6/atol=1e-9 (engine-level) and 1e-12/1e-14
(kernel). User-verified field-by-field parity against Python at
cycle 16 of SDM26 6000-rpm 25-cycle convergence run.

## Phase 2 — Full SDM26 config editor

**What landed:** The Config screen becomes a form-based editor for
every V1 SDM JSON field. Save (Ctrl+S) / Save-As (Ctrl+Shift+S);
bundled examples are read-only — Save on an example forces
Save-As. Dirty asterisk in the header; in-app discard-confirm modal
on nav-away while dirty. Engine-sim validates every save before
the file is written.

**Editor surface:**
- Field primitives: NumberField (commit-on-blur, SI-stored
  display-formatted with range hints), TextField, SelectField,
  CdTableField (rows + live uPlot scatter+line + monotonicity
  advisory), PipeArrayField (per-pipe rows with duplicate/remove
  + "+ Pipe" footer), FiringOrderField (N chips with left/right
  swap, validated against `n_cylinders`).
- Topology switch: 4-1 ↔ 4-2-1 via the synthetic `__topology`
  field; reducer mutates `exhaust_secondaries` and the secondaries
  table hides when in 4-1.
- "New from template…": modal with SDM26, SDM25, and a hand-crafted
  Blank template. Picking one loads it dirty (forces Save-As).
- "Diff…": pure `diffConfigs` engine walks the SDM schema +
  per-row pipe arrays + valve cd_tables. Modal renders a
  collapsible side-by-side grouped by schema section, with
  changed-row highlighting. Non-V1 second-source → red banner with
  "Pick a different file".

**Rust side:**
- `cfd-core/src/save.rs`: pure `save_config(path, raw)` — serializes
  via `serde_json::PrettyFormatter::with_indent("    ")` (matches
  bundled examples), validates via engine-sim's loader against a
  temp file, then atomic `<path>.tmp` → rename. Failed validation
  never touches the final path.
- Tauri commands `cfd_save_config` (with defense-in-depth refusal
  to overwrite paths inside the resource bundle) and
  `cfd_default_save_dir` (returns `<docs>/Helios/cfd/configs/`,
  creates it).
- `LoadedConfig` gains `isExample` (true when the loaded path
  resolves under the resource directory).

**Test counts:**
- Rust: cfd-core 26 (was 17 in Phase 1) + engine-sim 45 = 71.
- Frontend (vitest): 363 (was 271 before Phase 2; Phase 2 added
  ~92 editor tests across 8 files). Test files: 64.

**Tooling fix uncovered along the way:** Phase 1's frontend tests
under `src/modules/cfd/__tests__/` were never executing — the
`vitest.config.ts` `include` only matched `tests/**`. Fixed to
also match `src/**/__tests__/**`. NavRail's aria-current assertion
needed a `getByRole("button")` lookup after the Phase 1 styling
restyle moved the label inside a `<span>`.

**Out of scope (deferred to later phases):**
- Multi-step undo/redo.
- Drag-to-reorder firing-order (up/down arrows ship; drag is later
  polish).
- Sweeps, P-V loops, per-pipe profiles (Phase 3).
- Live per-step flow visualization (Phase 4).
- Sensitivity + optimization studies (Phase 5).
