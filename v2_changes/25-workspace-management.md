# 25 — User-managed workspaces (CRUD, color, reorder, export/import)

## Before

Workspaces were hardcoded in source. The array of workspace names and their order could only change by editing code. Tile contents (widget types, channel assignments, layout) were persisted to `localStorage`, but workspace-level operations — rename, reorder, duplicate, delete, add — required a code change and a rebuild.

## What changed

Workspaces are now fully user-managed at runtime.

**Workspace tab bar:**
- **New workspace** button (`+`) appends a blank workspace and enters rename mode.
- **Double-click** any tab to rename it inline.
- **Right-click context menu** on any tab: Rename, Color ▸ (8-swatch palette), Duplicate, Export…, Delete.
- **HTML5 drag-to-reorder** — drag tabs left or right; the array reorders live and persists.
- Every tab carries a **color swatch dot** from the 8-color palette; the active tab's underline bar reflects the chosen color.

**ConfirmDialog component:**
- Added a new `<ConfirmDialog>` component to replace the synchronous `window.confirm()` call in `handleResetWorkspaces`. The dialog is modal, keyboard-accessible, and consistent with the rest of the UI.
- Note: bare `confirm()` calls in `ConfigPanel.tsx` and `MathChannelsModal.tsx` are pre-existing and out of scope — future work.

**Export / import bundle format:**
- Export produces a JSON file typed `helios-workspace-bundle` v1 containing the workspace metadata and all tile configurations. This is intended as the foundation for sharing presets (including CSVs and math channels) across sessions in future phases.

**Storage migration v1 → v2:**
- The `localStorage` key is unchanged. A `version` field was added to the persisted blob; existing users on v1 (no `version` field) are migrated automatically — each legacy workspace receives a `color` filled in by palette index so no one loses their layout.

## Files changed

- `apps/desktop/src/components/WorkspaceTabBar.tsx` (new) — tab bar with drag-reorder, inline rename, drop indicator
- `apps/desktop/src/components/TabContextMenu.tsx` (new) — right-click menu with viewport-overflow flip + Color submenu
- `apps/desktop/src/components/ConfirmDialog.tsx` (new) — reusable confirm + alert modal
- `apps/desktop/src/lib/workspace-bundle.ts` (new) — pure `serializeBundle` / `parseBundle` / `mergeImported` / `slugifyForFilename`
- `apps/desktop/src/lib/workspace-dialog.ts` (new) — Tauri save/open file-dialog wrappers
- `apps/desktop/src/lib/workspace-storage.ts` — v1→v2 migration adding `color` field
- `apps/desktop/src/workspaces/types.ts`, `apps/desktop/src/workspaces/index.ts` — `+color` field on `Workspace`; built-ins assigned colors
- `apps/desktop/src/App.tsx` — replaces inline tab map with `<WorkspaceTabBar>`; adds 9 workspace mutation/export/import callbacks; wires `<ConfirmDialog>` for both Reset and Delete-workspace
- `apps/desktop/src-tauri/Cargo.toml`, `apps/desktop/src-tauri/src/lib.rs`, `apps/desktop/src-tauri/capabilities/default.json` — register `tauri-plugin-dialog` + `tauri-plugin-fs` with minimal text-file capabilities
- `apps/desktop/vitest.config.ts`, `apps/desktop/tests/setup.ts` (new) — jsdom + RTL test config for the desktop app
- `apps/desktop/tests/{workspace-storage,workspace-bundle,ConfirmDialog,TabContextMenu,WorkspaceTabBar}.test.{ts,tsx}` (new) — 50 of the 62 new unit tests (the rest are inline/imported helpers)
