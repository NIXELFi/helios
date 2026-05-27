# 40 — UI unification across Log / Vault / CFD

**Date:** 2026-05-27

The three top-level modules (Log, Vault, CFD) had visibly drifted apart. Log was the reference — small rounded-sm pill buttons, solid-gold active state, `bg-helios-panel` resting fill with `border-asu-gold` on hover. Vault's NavRail used big rounded text buttons with a dim-grey active state (no gold anywhere). CFD's NavRail was narrower, used a left-edge yellow border for active, used bare hex strings instead of helios-* tokens, and sat on a slightly darker body (`#0B0B0D` vs Log's `#0E0E10`).

The HELIOS wordmark and the updater pill also lived only on the Log screen — so the user couldn't see the version or trigger an update check while sitting in Vault or CFD.

## What

### HELIOS wordmark, version, and UpdatesPill moved to the ModulePicker sidebar

The sidebar (`shell/ModulePicker.tsx`) now has three stacked sections:

1. **Brand header** — `font-helios` "HELIOS" wordmark in `asu-gold`, with a `v{appVersion} · ground-station` subtitle. Top padding still clears the macOS traffic-lights overlay.
2. **Nav buttons** — Logs, Vault, CFD. Restyled with Log's pill language: `rounded-sm border bg-helios-panel`, hover gains `border-asu-gold`, active is filled `bg-asu-gold` with black text. The NEW badges now invert (gold-on-black) when the active button is selected so they stay readable on the gold fill.
3. **Updater footer** — pinned to the bottom of the rail with a `border-t`. Hosts the existing `UpdatesPill` so update-check / install affordance is reachable from every module.

The `Shell.tsx` now owns the updater state, the live `getVersion()` call, the modal-open flag, and the playback flag (lifted from `App.tsx` so the "pause before install" guard still works when the install is triggered from a non-Log module).

### Logo + updater removed from Log's top header

`App.tsx`'s header no longer renders the HELIOS span or the UpdatesPill — those are in the sidebar now. The `UpdateModal` is also gone from `App.tsx`; it's mounted at the shell level so it can fire over any module. `App` now takes `appVersion`, `playing`, and `onPlayingChange` as props from `Shell`.

### Vault NavRail aligned with Log's button language

`modules/vault/components/NavRail.tsx`:

- Active = `bg-asu-gold text-helios-base font-semibold` (was the dim `bg-helios-line`).
- Inactive = `bg-helios-panel border-helios-line text-helios-text` with `hover:border-asu-gold` (was bare hover-bg-panel).
- `rounded-sm` pills with `py-1.5` instead of `rounded px-3 py-2`.

### CFD NavRail aligned with Log/Vault

`modules/cfd/components/NavRail.tsx`:

- Widened from `w-32` to `w-44` so all three rails share a width.
- Bare hex strings (`#0E0E10`, `#FFC627`, `#2A2C32`, etc.) replaced with `helios-*` tokens.
- Active state changed from "yellow left-border + dim background" to the same solid gold fill used in Log and Vault.
- Kept the `text-[11px] uppercase tracking-wider` typography because CFD's screen-level micro-headers ("Engine config", "Studies", etc.) use the same treatment — the labels read as one consistent family.

### CFD screen body backgrounds standardized

Top-level screen containers in CFD used `bg-[#0B0B0D]` (slightly darker than Log's body). Swapped to `bg-helios-base` (`#0E0E10`) so all three modules sit on the same background:

- `CfdHome.tsx`
- `screens/ConfigScreen.tsx`
- `screens/StudiesScreen.tsx`
- `screens/ResultsScreen.tsx`
- `results/SingleRpmResults.tsx`
- `results/SweepResults.tsx`
- `results/OptimizationResults.tsx`

Inner CFD styling (form fields, table thead, modal chrome) intentionally left untouched — those use `#0B0B0D` as a "recessed input" background and the convention is internally consistent within CFD's editor screens.

### Dead prop cleanup

`WorkspaceTabBar` had an `appVersion: string` prop that was never read inside the component. Removed.

## Files of note

- `apps/desktop/src/Shell.tsx` — owns updater + version + playback state, mounts UpdateModal.
- `apps/desktop/src/shell/ModulePicker.tsx` — new brand header + nav + updater footer.
- `apps/desktop/src/App.tsx` — accepts props for `appVersion`, `playing`, `onPlayingChange`; removed local updater/version/playing state, removed UpdatesPill + UpdateModal from header, removed HELIOS span.
- `apps/desktop/src/modules/vault/components/NavRail.tsx` — restyled to Log's pill language.
- `apps/desktop/src/modules/cfd/components/NavRail.tsx` — widened, tokenized, gold-fill active.
- CFD screens listed above — bare-hex body bg → `bg-helios-base`.
- `apps/desktop/tests/ModulePicker.test.tsx` — updated to pass the new required props, plus two new assertions covering the sidebar wordmark/version and the updates-pill click handler.

## Follow-up polish

### Platform-aware sidebar top padding

`ModulePicker`'s brand header was using a hard-coded `pt-12` to clear the macOS traffic-lights overlay. On Windows / Linux the native title bar already sits above the webview, so that padding showed up as ~48 px of dead space at the top-left. Detected the OS once at module load via `navigator.userAgent` and switched the top padding to `pt-12` (macOS) / `pt-3` (Windows / Linux). No new plugin required.

### Wave-viewer visual polish

The wave-viewer modal (`apps/desktop/src/modules/cfd/results/wave-viewer/`) read as a different app than the rest of CFD — plain `<h2>` title, browser-default `<select>`s and range slider, near-invisible canvas connection lines, fluorescent stroke-phase labels. Brought it back into the Helios family:

- **Modal header** uses the CFD micro-header treatment (asu-gold uppercase tracking-wider label, dim info subtitle, helios-panel close pill).
- **Transport bar** picks up the workspace-tab pill language. Replaced inline `<label>RPM:<select>…</select></label>` blocks with a `SelectField` helper that renders each control as a single rounded-sm pill (dim uppercase label + transparent dark select). Play/Pause goes solid gold while playing; step buttons match the rest of CFD's chrome.
- **Frame scrubber** swapped from the browser-default `<input type="range">` to a custom helios-yellow thumb on a 4 px helios-line track (`.wave-scrubber` in `styles.css`, both `-webkit-*` and `-moz-*` pseudo-elements covered).
- **Schematic canvas**:
  - Connection lines bumped from `#3A3F47` → `#5A5F66` so the pipe-network topology actually reads.
  - Pipe outlines bumped from `#2A2C32` → `#3A3F47` for the same reason; bore outline from `#5A5F66` → `#6A6F76`.
  - Hairline cell separators (translucent `helios-base`) drawn between cells when cell pitch is > 3 px, so pipes read as a discrete cell grid instead of a fuzzy band.
  - INTAKE / EXHAUST side labels moved 6 px inboard, switched to spaced-character uppercase tracking and Inter so they match the rest of the app's section labels.
  - Pipe and cylinder labels switched from `ui-monospace` to Inter 600 — cleaner at 10 px.
  - Stroke-phase labels (POWER / COMPRESSION / EXHAUST / INTAKE) softened — the previous palette ran `#4FC3F7 / #9097A0 / #FFAB40 / #FF8A65` (near-fluorescent against helios-base). New palette is muted (`#7FB3D5 / #9097A0 / #E8A847 / #A77860`), and the label now renders as a small colored dot + neutral helios-text label so the phase indicator reads as supporting metadata rather than competing with the colormap.
- `SchematicView.tsx`'s wrapper `bg-[#0E0E10]` → `bg-helios-base` for token consistency (visually identical).
- `apps/desktop/src/modules/cfd/results/wave-viewer/__tests__/WaveViewerModal.test.tsx` — updated one label regex (`/rpm:/i` → `/rpm/i`) since the new `SelectField` drops the trailing colon.

### CFD NavRail — Clear data button

Added a "Clear data" button at the top of the CFD NavRail (above the Config entry). Shows the current disk usage of `<Documents>/Helios/cfd/captures` so the user can see what they're about to wipe, and opens a `ConfirmModal` before deleting. Engine configs (`<Documents>/Helios/cfd/configs/`) are explicitly **not** touched — the delete is scoped to the captures directory only.

- **Rust (`apps/desktop/src-tauri/src/cfd/commands.rs`)** — two new commands:
  - `cfd_data_usage_bytes()` — recursively walks the captures dir and returns the total size in bytes (0 if missing).
  - `cfd_clear_data()` — `remove_dir_all` on the captures dir, then `create_dir_all` to leave an empty captures dir behind so future jobs land cleanly. Both registered in `apps/desktop/src-tauri/src/lib.rs`.
- **Bridge** — `CfdBridge` gains `dataUsageBytes()` / `clearAllData()`; the real bridge invokes the two new commands; the test fake records invocations and exposes `setDataUsageBytes` / `setClearAllData`.
- **NavRail** — accepts `dataUsageBytes` (nullable; renders `…` while loading) and `onRequestClearData`. The Clear-data button sits above a `border-b` divider; on hover the chrome shifts to a muted red-tinted state so the action reads as destructive. Exports a `formatDataSize` helper (GB / MB / KB / B) used both in the button label and the confirm-dialog body.
- **CfdShell** — measures usage once on mount, re-measures after every `cfd:job-done` / `cfd:job-cancelled` / `cfd:job-error` event, and refreshes immediately after a successful clear. The confirm dialog explicitly calls out which directory is wiped, names the configs dir as safe, and surfaces clear-errors inline.
- **Tests** — `NavRail.test.tsx` gains two assertions covering the Clear-data button + the loading state, plus a `formatDataSize` unit suite. Existing assertions were anchored (`/^Config$/i`) so the "configs preserved" subtitle on the new button doesn't shadow the screen-nav `/Config/i` probe.
