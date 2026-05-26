# 39 — CFD tab Phase 4: animated wave-frame viewer + per-pipe waterfall

Phase 4 lights up the animated wave-frame viewer the Phase 3 plumbing
was waiting on. Open it from the Captures bar in any single-RPM or
sweep result that has "Record waves" enabled.

## What it does

- **Schematic view (default).** Anatomical engine layout — plenum on
  top, runner column, cylinder row (circles), primaries, secondaries
  (when the config has them), collector at bottom. Layout is
  data-driven from the manifest's pipe roles, so any engine
  config renders without code changes.

- **Cells.** Each pipe's cells are colored by a selectable field
  (pressure / velocity / temperature / density / Mach — Mach is
  derived from u and T at view time). The cell's perpendicular extent
  scales with a second selectable field (defaults to pressure), so
  pressure waves visibly breathe through the geometry.

- **Cylinders.** Diameter scales with cylinder pressure (log so idle
  is still visible). Fill follows a cyl-field selector
  (x_b / pressure / temperature).

- **Waterfall sub-view.** Per-pipe x-t heatmap. Pick a pipe + field,
  see the full captured cycle as a 2-D image. Click on it to jump
  the schematic's playhead.

- **Sweep RPM switcher.** For sweep studies, the modal has a dropdown
  of every captured RPM and re-loads on selection. Field / size /
  cylField / speed persist; scrub resets.

## Playback

Speed: 0.25× / 0.5× / 1× / 2× / 4× / 8× (default 0.25× — 1× plays a
real-engine cycle in 15 ms at 8000 rpm, too fast to follow).
Scrubber. Play/pause. Frame-step.

## Backend

One new Tauri command — `cfd_load_waves` — JSONL-aware sibling of
`cfd_load_capture`. Reads `manifest.json` + `waves.jsonl` from
`<Documents>/Helios/cfd/captures/<job_id>/<kind>/<rpm_int>/` and
returns `{ manifest, frames }`. First parse error aborts with the
bad line number — no partial loads.

Pure logic + tests live in `crates/cfd-core/src/load.rs` (sibling
to `load_config_from_path`); `commands.rs` keeps only the thin
`#[tauri::command]` wrapper. No backend math changes; no parity
test impact. Capture writer from Phase 3 unchanged.

## Limits / out of scope

- Captures only the **last** cycle. Multi-cycle capture is a separate
  finding.
- No brush-to-scrub on the waterfall (click-to-jump only).
- No side-by-side compare across studies / RPMs.
- No animation export (MP4 / GIF).
- No species (Y) field (no species data on disk today).

## Files

Frontend: `apps/desktop/src/modules/cfd/results/wave-viewer/`
- `WaveViewerModal.tsx`, `SchematicView.tsx`, `WaterfallView.tsx`
- `useWaveCapture.ts`, `colormaps.ts`, `fields.ts`, `layout.ts`

Backend: `crates/cfd-core/src/load.rs` (`load_waves_from_dir` +
6 tests); `apps/desktop/src-tauri/src/cfd/commands.rs`
(`cfd_load_waves` thin wrapper).

Spec: `docs/superpowers/specs/2026-05-26-cfd-tab-phase-4-wave-viewer-design.md`.
Plan: `docs/superpowers/plans/2026-05-26-cfd-tab-phase-4-wave-viewer-plan.md`.
