# CFD Tab — Phase 2 Design

**Date:** 2026-05-21
**Status:** ready for implementation planning
**Predecessor specs:**
- [2026-05-21-cfd-tab-phase-1-design.md](2026-05-21-cfd-tab-phase-1-design.md)
- [2026-05-20-engine-sim-rust-port-design.md](2026-05-20-engine-sim-rust-port-design.md)

## Goal

Turn Phase 1's read-only Config screen into a full form-based editor for
the V1 SDM JSON schema. Phase 2 ships save/load (with bundled examples
treated as read-only), client-side + engine-sim validation, an editable
valve Cd-table with a live curve plot, pipe-array editing (including
4-1 ↔ 4-2-1 topology change), a "new from template" picker, and a
side-by-side diff against a second config.

Phase 1 left a clean foundation: `LoadedConfig.raw` (a
`Record<string, unknown>` from the V1 JSON) is the editable model, the
`sdm26Schema.ts` metadata already drives the read-mode grid, and the
Tauri command surface is generic enough to extend (`cfd_save_config`
slots in alongside `cfd_load_config`).

## Scope

In scope:

- Editor state machine for the SDM26 V1 JSON config: draft + saved
  snapshot + dirty tracking + field/global errors.
- Field primitives: number, text, select, array-of-numbers, Cd-table
  (with live curve plot), pipe-array, firing-order.
- Inline client-side validation (range, type, required); blocking
  engine-sim validation on Save.
- Save (Ctrl+S) and Save-As (Ctrl+Shift+S) with native dialogs.
  Bundled examples are read-only — Save on an example forces Save-As.
- Atomic file write via a Tauri command (`cfd_save_config`).
- New from template: SDM26, SDM25, Blank (minimal valid).
- Topology change (4-1 ↔ 4-2-1) with confirmation.
- Diff modal: pick a second config, render both side-by-side grouped
  by schema section, changed fields highlighted.
- Default save directory: `Documents/Helios/cfd/configs/` (created on
  first save). Recent files persisted in localStorage.
- Vitest unit tests for the editor state machine, field rendering,
  validation rules, diff computation, template materialization.
- Rust unit tests for `cfd_save_config` and `cfd_default_save_dir`.

Out of scope (deferred to later phases):

- Live per-step flow visualization (Phase 4).
- Sweep + optimization (Phase 3 + 5).
- Editing configs that aren't V1 SDM JSON.
- Bulk file operations / config library management UI.
- Versioned undo history (the editor supports last-saved-vs-draft
  diff but not multi-step undo/redo).

## Section 1 — Architecture overview

The Phase 1 Config screen is upgraded in place. When the loaded
config is bundled (read-only), the schema grid still renders inputs but
on Save we redirect to Save-As. When the loaded config is user-owned,
Save writes back to its path. The "Edit" toggle is implicit: clicking
a field starts editing.

### Module additions

```
apps/desktop/src/modules/cfd/
├── editor/
│   ├── state/
│   │   ├── editor-context.tsx       — useReducer-based editor state
│   │   └── editor-actions.ts         — pure reducer + path-based set/delete helpers
│   ├── fields/
│   │   ├── NumberField.tsx           — numeric input with range hint + warning
│   │   ├── SelectField.tsx
│   │   ├── TextField.tsx
│   │   ├── ArrayField.tsx            — list of editable rows (generic, used by firing-order)
│   │   ├── CdTableField.tsx          — Cd-table rows + live uPlot scatter
│   │   ├── PipeArrayField.tsx        — pipe rows with add / duplicate / remove
│   │   └── FiringOrderField.tsx      — N-slot drag-to-reorder
│   ├── validation/
│   │   ├── client-rules.ts            — per-field validators (range, type, required)
│   │   └── ValidationBanner.tsx      — top-of-screen error banner
│   ├── diff/
│   │   ├── diff-engine.ts             — pure: compare two raw configs → per-field diff
│   │   └── ConfigDiffModal.tsx       — modal: pick second config, render side-by-side
│   ├── templates/
│   │   ├── templates.ts               — sdm26 / sdm25 / blank in-memory templates
│   │   └── TemplatePickerModal.tsx
│   └── lib/
│       ├── path-helpers.ts            — dot-path get/set on raw JSON (immer-style)
│       └── deep-equal.ts              — structural equality for dirty tracking
└── lib/sdm26Schema.ts                 — extended with min/max/step/required/type per field
```

### Editor state model

```ts
interface EditorState {
  draft: Record<string, unknown>;          // current edits, editable shadow of raw JSON
  savedSnapshot: Record<string, unknown>;  // last successful save (or initial load)
  savedPath: string | null;                 // null = synthetic (template / unnamed)
  isExample: boolean;                       // true if savedPath points at a bundled resource
  fieldErrors: Record<string, string>;     // dot-path → client-side error message
  globalError: string | null;               // engine-sim's loader error on save attempt
  diffOpen: boolean;                        // diff modal visibility
  templatePickerOpen: boolean;
}
```

`dirty` is derived: `!deepEqual(draft, savedSnapshot)`. Drives the
asterisk in the header and the "discard changes?" confirm modal.

### Read mode vs edit mode

There is no explicit "Edit" toggle. The schema grid in
`ConfigScreen` always renders editable inputs once a config is
loaded. When `EditorState.draft === savedSnapshot` (clean), the
header simply shows the path without an asterisk; Save and Discard
buttons are disabled. As soon as any field changes, the asterisk
appears and Save/Discard become active. This keeps the model dead
simple.

### Bundled-example handling

Examples live at `apps/desktop/src-tauri/resources/cfd/configs/`.
After `cfd_load_config`, the loader compares the path against the
resource directory and returns `isExample: true` on `LoadedConfig`
(new field this phase). The editor treats `isExample` as "Save
redirects to Save-As" and disables the "Save" button when
`savedSnapshot === draft` (nothing to save anyway) — but on first
edit the Save button becomes active and a small "(example: edits
will require Save As…)" hint appears under the path.

Both the explicit `Examples ▾` dropdown (existing Phase 1 flow)
and the file-picker `Open…` flow route through `cfd_load_config`,
so `isExample` is set identically in both cases — there is no
separate "load example" code path that bypasses the check.

## Section 2 — Tauri command surface

New commands registered alongside Phase 1's in
[apps/desktop/src-tauri/src/lib.rs](apps/desktop/src-tauri/src/lib.rs):

```rust
#[tauri::command]
pub fn cfd_save_config(path: String, raw: serde_json::Value) -> Result<(), String>;
// 1. Serialize `raw` to text (pretty-printed JSON, 4-space indent — matches
//    the bundled examples' style).
// 2. Parse via engine_sim::config::loader::load_v1_json on a *temp* path
//    first, so we surface the same error string `cfd_load_config` does.
//    On schema / physics error, return Err(message) WITHOUT writing.
// 3. Atomic write: write to `<path>.tmp` then rename onto `path`.
// 4. Return Ok(()).

#[tauri::command]
pub fn cfd_default_save_dir(app: tauri::AppHandle) -> Result<String, String>;
// Returns `<user_documents>/Helios/cfd/configs/` (creates it on first call).
// Uses tauri::Manager::path() to resolve user_documents per-OS.
```

Loaded-config DTO gains a flag:

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedConfig {
    pub path: String,
    pub raw: serde_json::Value,
    pub summary: ConfigSummary,
    pub is_example: bool,   // NEW: true when path is inside the bundle's resource dir
}
```

The frontend bridge gains a thin wrapper:

```ts
saveConfig: (path: string, raw: Record<string, unknown>) =>
  invoke<void>("cfd_save_config", { path, raw }),
defaultSaveDir: () => invoke<string>("cfd_default_save_dir"),
```

Tauri capabilities: `fs:write` permission for `$DOCUMENT/Helios/**`
plus the existing user-picked-path scope from the `plugin-dialog`
save() result (the dialog returns a path the app already has scope
for).

## Section 3 — Field primitives and schema extension

`sdm26Schema.ts`'s `FieldMeta` is extended:

```ts
type FieldType = "number" | "integer" | "text" | "select" | "boolean";

interface FieldMeta {
  key: string;            // dot-path into raw
  label: string;
  unit?: string;
  group: string;
  type: FieldType;        // NEW: required from now on
  format?: (v: unknown) => string;
  // Validation:
  min?: number;           // numeric only
  max?: number;
  step?: number;
  required?: boolean;
  options?: ReadonlyArray<string | { value: string; label: string }>;
  // Display:
  formatInverse?: (s: string) => unknown;  // user enters "67.0", stored as 0.067 m
}
```

For SI-converted display (bore: 67.0 mm rendered, stored as 0.067 m):
`format` produces the display string, `formatInverse` parses the
user's typed value back to SI for storage. NumberField uses both.

**Units rule:** `min`, `max`, `step`, and the stored value are all in
**SI base units** (meters, seconds, kelvin, etc. — matching the V1
JSON on disk). `format` / `formatInverse` only affect the displayed
input string. Range hints in the field UI render via `format` so the
user sees "67.0 – 120.0 mm" not "0.067 – 0.120 m". The validator
operates on the stored SI value.

### Field components

- **NumberField** — controlled input. Shows `unit` as a suffix. Below
  the input: range hint ("0.05 – 0.12 m" greyed). On blur, runs the
  client validator; if failing, adds the field error and displays a
  yellow inline message under the input. Pure controlled.

- **TextField** — same shape, simpler (no formatInverse).

- **SelectField** — `<select>` with `options`. Used by topology
  ("4-1" / "4-2-1") and any future enum field.

- **ArrayField** — generic editable row list with add / move-up /
  move-down / remove. Used for `firing_order` (specialized via
  `FiringOrderField` to add the "N=number-of-cylinders" constraint
  and slot validation).

- **CdTableField** — table of (L/D, Cd) rows above a small uPlot
  scatter+line chart. Rules:
  - Rows are sorted by L/D ascending on every edit (auto-sort).
  - Plot updates via setData on every change.
  - Monotonicity warning: if Cd values are non-monotonic by more
    than 5%, a yellow inline warning appears (not blocking).
  - Add/remove buttons; minimum 2 rows enforced.

- **PipeArrayField** — table of pipe rows. Each row's columns: name
  (text), length (mm, with formatter), diameter in (mm), diameter
  out (nullable, with "—" placeholder), n_points (integer),
  wall_temperature (K), roughness (number, default 4.6e-5 for
  exhaust / 3e-5 for intake). Actions per row: duplicate, remove.
  "Add pipe" button below.

- **FiringOrderField** — N slots showing the order. Drag-to-reorder
  in Phase 2 if cheap, otherwise up/down arrows. Validates that the
  array contains exactly N unique integers 1..N and matches
  `n_cylinders`.

### Validation rules

`client-rules.ts` defines `validateField(meta, value)` returning
`{ ok: true } | { ok: false; message: string }`. Rules:
- Required: empty / null / NaN fails.
- Integer: non-integer fails.
- Number: NaN fails.
- Range: `< min || > max` fails.
- Custom per-field rules: bore > 0, stroke > 0, compression_ratio
  >= 1, firing_order length == n_cylinders, etc.

The reducer recomputes `fieldErrors` on every change action so the
UI can render inline errors live.

### Save validation pipeline

On Save:
1. Recompute all `fieldErrors`. If any non-empty → block save, focus
   first error, show toast "Fix the highlighted fields."
2. Call `cfd_save_config(path, draft)`. Rust runs
   `engine_sim::config::loader::load_v1_json` first; on `Err`,
   surfaces the message back as `globalError`. UI renders red
   `ValidationBanner` at the top of the screen with the message.
3. On `Ok`, dispatch `saveSucceeded` to update `savedSnapshot` to a
   structural clone of `draft`, set `savedPath = path`, clear
   `globalError`, refresh the CfdContext's `loadedConfig`.

## Section 4 — UX flows

### Header strip (Config screen, updated)

```
ENGINE CONFIG · ~/Documents/Helios/cfd/configs/my-tweaks.json *      [ New… ] [ Open… ] [ Examples ▾ ] [ Diff… ] [ Discard ] [ Save ] [ Save As… ]
                                                       ^ dirty asterisk
```

When `isExample === true`:
```
ENGINE CONFIG · resources/cfd/configs/sdm26.json (example)    [ New… ] [ Open… ] [ Examples ▾ ] [ Diff… ] [ Discard ] [ Save As… ]
```

- **New…** opens `TemplatePickerModal`.
- **Open…** existing Phase 1 flow.
- **Examples ▾** existing Phase 1 flow.
- **Diff…** opens `ConfigDiffModal`.
- **Discard** appears only when `dirty`. Opens a custom in-app
  confirm modal ("Discard unsaved changes?" — no `window.confirm`).
- **Save** disabled when `!dirty` or `isExample`.
- **Save As…** disabled when `!dirty`.

### Keyboard shortcuts (CFD module only)

- `Ctrl+S` (Cmd+S on Mac): Save. Falls through to Save-As if
  `isExample` or `savedPath == null`.
- `Ctrl+Shift+S`: Save-As.
- `Esc` on any open modal: cancel.

Shortcut scope: only active while the CFD tab is the visible
module. Wired via a module-scoped `useEffect` in `CfdHome`.

### Template picker modal

Modal listing three rows: SDM26 (default starting point), SDM25
(legacy variant), Blank (minimal valid SDM26 with sensible
defaults — name "New engine", n_cylinders 4, default valves, one
runner per cylinder, 4-1 topology, no secondaries). Selecting one:
- Loads its raw into `draft`.
- Sets `savedSnapshot = {}` (initial empty so everything is dirty,
  forcing the user to Save before running).
- Sets `savedPath = null`, `isExample = false`.
- Closes the modal.
- The Save button immediately routes to Save-As (no current path).

### Diff modal

Modal flow:
1. Open via `Diff…` button. If draft is dirty, prompt: "Compare
   saved or current?" — radios: "Last-saved snapshot" (default) /
   "Current draft (unsaved)".
2. Pick second source: "Open file…" (native dialog) or pick a
   bundled example.
3. Renders both configs grouped by schema section. Each field row
   shows `label · A → B` with both values; changed fields get a
   yellow background, identical fields are dimmed. Sections with
   no changes collapse to a one-line summary.

The diff is computed by `diff-engine.ts` — a pure function over
two `Record<string, unknown>` returning `Array<{ group, key,
left, right, kind: "added" | "removed" | "changed" | "same" }>`.

If the second source fails to parse as a V1 SDM JSON (Rust's
`cfd_load_config` returns Err), the diff modal renders a red
banner `"Couldn't load comparison config: {error}"` and offers a
"Pick a different file" button — no diff rendered. Phase 2's diff
is V1-only; non-V1 schemas are not in scope.

### Topology change

Implemented as a select in the schema (group "Exhaust"). The
field's `formatInverse` doesn't apply; instead, choosing a new
topology opens a `ConfirmModal`:
- 4-1 → 4-2-1: "Switching to 4-2-1 will add 2 secondary pipes
  defaulted from your current primaries. Continue?"
- 4-2-1 → 4-1: "Switching to 4-1 will remove the 2 existing
  secondary pipes. Continue?"
Confirm dispatches an action that mutates `draft.exhaust_secondaries`
accordingly. The PipeArrayField for secondaries gates its display
on `draft.exhaust_secondaries?.length > 0`.

## Section 5 — Error handling

All errors surface in-app, never via `window.alert/confirm`.

- **Client-side field errors** — inline yellow message under the
  field, plus an aggregate "X issues" pill at the top of the form.
  Save is blocked.
- **Engine-sim validation error** — red banner at the top of the
  form, blocking Save. Contains the engine-sim message verbatim
  (file:line where possible).
- **File I/O errors** (couldn't write, permission denied, etc.) —
  red banner same as above; message prefixed "Couldn't save:".
- **Unsaved changes on navigation** — clicking another NavRail
  entry, switching modules, or closing the app while dirty opens
  the discard-confirm modal first. CFD-module-scope only.
- **Bundled example save attempt** — should be unreachable because
  Save is hidden. As a defense-in-depth: `cfd_save_config` checks
  the path and rejects if it lies inside the resource dir.

## Section 6 — Testing strategy

### Frontend (vitest)

- `editor-actions.test.ts` — reducer tests:
  - `setField(path, value)` updates `draft.path` immutably.
  - `setField` recomputes `fieldErrors[path]`.
  - `loadTemplate(template)` replaces draft, resets savedSnapshot to
    {} (so dirty flag is true).
  - `addPipeRow` / `removePipeRow(idx)` / `duplicatePipeRow(idx)`
    on `intake_pipes` work correctly.
  - `changeTopology("4-1")` deletes `exhaust_secondaries`;
    `changeTopology("4-2-1")` adds two defaulted secondaries.
  - `saveSucceeded(path, isExample)` updates `savedSnapshot =
    structuredClone(draft)`, sets `savedPath`, clears errors.
  - Dirty computed flag flips correctly across edits and saves.

- `client-rules.test.ts` — every validator: range, integer,
  required, monotonic Cd-table, firing-order uniqueness.

- `diff-engine.test.ts` — given two configs, returns the expected
  diff entries. Edge cases: added field, removed field,
  type-mismatched value, deeply nested array.

- `templates.test.ts` — every template materializes to a config
  that round-trips through `cfd_save_config` mock and parses (via
  a Rust-side test).

- Component tests:
  - `NumberField.test.tsx` — typing updates value, blur runs
    validator, formatter renders SI vs display units correctly.
  - `CdTableField.test.tsx` — adding rows updates the plot's
    setData call (mocked uPlot wrapper).
  - `PipeArrayField.test.tsx` — duplicate adds a copy of the
    selected row; remove deletes only that row.
  - `ConfigScreen.test.tsx` — extended:
    - Dirty header asterisk appears after a field change.
    - Save button disabled when `isExample === true`.
    - Save-As button calls `cfdApi.saveConfig` with the picked
      path.
  - `ConfigDiffModal.test.tsx` — opens, shows diff, identical
    sections collapse.
  - `TemplatePickerModal.test.tsx` — three rows, picking one calls
    `loadTemplate`.

### Rust (cargo test)

- `commands.rs`:
  - `cfd_save_config_writes_pretty_json_atomically` — saves to
    temp path, checks `<path>.tmp` no longer exists after save,
    re-reads the file and verifies a known value.
  - `cfd_save_config_rejects_invalid_config` — sends a raw
    missing the `cylinder` field; expects engine-sim's error
    text back.
  - `cfd_save_config_rejects_bundle_resource_path` — defense in
    depth.
  - `cfd_default_save_dir_creates_directory` — runs the command
    twice; second call doesn't error.

- No new parity tests required: the math is unchanged. The Phase 1
  parity matrix continues to guard correctness end-to-end.

### Manual verification gate

Before claiming Phase 2 done:
1. Load SDM26 example → edit bore from 67 → 70 mm → Save (forced
   Save-As). Re-open: edit persisted.
2. New from template → Blank → bore 67, stroke 42.5, compression
   ratio 12 → Save-As. Re-open + Run sim → produces sensible
   numbers.
3. Switch topology 4-2-1 → 4-1 with confirmation → Save → re-run
   sim succeeds with 4-1 path.
4. Diff `my-tweaks.json` vs SDM26 example → bore row highlighted.
5. Enter invalid value (bore = -1) → field error appears, Save is
   blocked.
6. Enter physically nonsense values that pass client rules
   (compression ratio 0.5 — engine-sim rejects) → red engine-sim
   banner; Save is blocked.

## Cross-cutting decisions

- **No `window.alert/confirm/prompt`.** Memory:
  `feedback_no_browser_dialogs.md`. Reuse Phase 1's
  `ConfirmModal`.
- **`f64` end-to-end.** JSON serialization is exact.
- **`v2_changes/` log.** Memory: `feedback_v2_changes_log.md`. A
  short entry per shipped change (one file per issue/fix).

## Non-decisions explicitly punted

- Multi-step undo/redo (only last-saved-vs-draft).
- Drag-to-reorder for `firing_order` — Phase 2 ships up/down arrow
  buttons; the drag affordance can land later as polish without
  changing the underlying field shape.
- Schema migrations (V1 → V2 JSON). V2 doesn't exist yet.
- Editing arbitrary JSON outside the SDM schema.
