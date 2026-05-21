# CFD Tab — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Phase 1's read-only Config screen into a full editor for the V1 SDM JSON schema, with save/load, validation, valve Cd-table editing, pipe-array editing (4-1 ↔ 4-2-1 topology), new-from-template, and a side-by-side diff against another config.

**Architecture:** Editor state machine layered on top of `LoadedConfig.raw` (Phase 1's `Record<string, unknown>`). Schema-driven field primitives. Save flows through a new `cfd_save_config` Tauri command that round-trips through engine-sim's validator before writing atomically. Bundled examples are read-only — Save on an example forces Save-As.

**Tech Stack:** TypeScript + React 18, uPlot for the Cd-table curve plot, Tauri 2 + `@tauri-apps/plugin-dialog`'s save dialog, Rust 2024-edition for the save command, vitest + @testing-library/react for tests.

**Predecessor spec:** [docs/superpowers/specs/2026-05-21-cfd-tab-phase-2-design.md](../specs/2026-05-21-cfd-tab-phase-2-design.md)
**Phase 1 spec:** [docs/superpowers/specs/2026-05-21-cfd-tab-phase-1-design.md](../specs/2026-05-21-cfd-tab-phase-1-design.md)

---

## File map

### `crates/cfd-core/` — pure logic (where save validation + isExample live)

| Path | Action | Responsibility |
|---|---|---|
| `src/dto.rs` | modify | Add `is_example: bool` to `LoadedConfig`; add `SaveConfigRequest` DTO if useful. |
| `src/save.rs` | create | Pure save logic: validate `raw` via engine-sim loader → pretty-print JSON → atomic temp-then-rename. Owns the unit-test surface. |

### `apps/desktop/src-tauri/` — Tauri command wrappers

| Path | Action | Responsibility |
|---|---|---|
| `src/cfd/commands.rs` | modify | Add `cfd_save_config` + `cfd_default_save_dir` commands. Update `cfd_load_config` to populate `is_example` by checking the resource dir. |
| `src/lib.rs` | modify | Register the two new commands in `invoke_handler`. |
| `capabilities/default.json` | modify | Grant `fs:write` for `$DOCUMENT/Helios/cfd/configs/**`. (If existing capability format differs, adapt.) |

### `apps/desktop/src/modules/cfd/` — editor module

| Path | Action | Responsibility |
|---|---|---|
| `lib/tauriBridge.ts` | modify | Add `saveConfig` + `defaultSaveDir` methods. |
| `state/types.ts` | modify | Add `isExample` to `LoadedConfig`. |
| `state/CfdContext.tsx` | modify | After save success, update `loadedConfig` so the rest of the app sees the new state. |
| `lib/sdm26Schema.ts` | modify | Extend `FieldMeta` with `type`, `min`, `max`, `step`, `required`, `options`, `formatInverse`. Add entries for previously-omitted fields. |
| `editor/lib/path-helpers.ts` | create | `getAt(obj, path)`, `setAt(obj, path, value)`, `deleteAt(obj, path)` — immutable, dot-path. |
| `editor/lib/deep-equal.ts` | create | Structural equality for dirty tracking. |
| `editor/state/editor-actions.ts` | create | Pure reducer + actions: `setField`, `loadTemplate`, `addPipeRow`, `removePipeRow`, `duplicatePipeRow`, `changeTopology`, `saveSucceeded`, `discardChanges`, `openDiff`, `closeDiff`, `openTemplatePicker`, `closeTemplatePicker`, etc. |
| `editor/state/editor-context.tsx` | create | React context wrapping the reducer; subscribes to `CfdContext.loadedConfig` changes; exposes `useEditor()`. |
| `editor/validation/client-rules.ts` | create | `validateField(meta, value): Result` + `validateAll(schema, raw): Record<string, string>`. |
| `editor/fields/NumberField.tsx` | create | Numeric input with unit suffix, range hint, error display. |
| `editor/fields/TextField.tsx` | create | Plain text input. |
| `editor/fields/SelectField.tsx` | create | Select with `options`. |
| `editor/fields/CdTableField.tsx` | create | Cd-table rows + live uPlot scatter+line. |
| `editor/fields/PipeArrayField.tsx` | create | Per-pipe rows with add/duplicate/remove. |
| `editor/fields/FiringOrderField.tsx` | create | N-slot up/down reorder. |
| `editor/templates/templates.ts` | create | SDM26, SDM25, Blank template materializers (in-memory raw objects). |
| `editor/templates/TemplatePickerModal.tsx` | create | Modal with three rows, calls `loadTemplate`. |
| `editor/diff/diff-engine.ts` | create | Pure `diffConfigs(left, right, schema)` → ordered entries. |
| `editor/diff/ConfigDiffModal.tsx` | create | Modal: pick second config, render diff. |
| `screens/ConfigScreen.tsx` | rewrite | Composes editor context + schema → fields. Header has Save/Save-As/Discard/Diff/New buttons + dirty asterisk. |
| `__tests__/editor/path-helpers.test.ts` | create | |
| `__tests__/editor/editor-actions.test.ts` | create | |
| `__tests__/editor/client-rules.test.ts` | create | |
| `__tests__/editor/diff-engine.test.ts` | create | |
| `__tests__/editor/templates.test.ts` | create | |
| `__tests__/editor/NumberField.test.tsx` | create | |
| `__tests__/editor/CdTableField.test.tsx` | create | |
| `__tests__/editor/PipeArrayField.test.tsx` | create | |
| `__tests__/editor/ConfigScreen.editor.test.tsx` | create | The end-to-end-ish frontend test for the editor flow. |

---

## Wave ordering

- **Wave A — Rust save + isExample (Tasks 1-4).** Independent foundation. Frontend can mock against it via the fake bridge once contracts are set.
- **Wave B — Editor state + schema (Tasks 5-9).** Pure TS + reducer; testable without UI.
- **Wave C — Field primitives (Tasks 10-14).** NumberField, TextField, SelectField, CdTableField, PipeArrayField, FiringOrderField. TDD per file.
- **Wave D — Composition (Tasks 15-16).** ConfigScreen rewrite + topology confirmation flow.
- **Wave E — Templates + Diff (Tasks 17-19).** Modals + their tests.
- **Wave F — Verification (Tasks 20-22).** Full test suite, manual smoke, final commit.

---

## Wave A — Rust save + `is_example`

### Task 1: Add `is_example` to LoadedConfig DTO + populate in cfd_load_config

**Files:**
- Modify: `crates/cfd-core/src/dto.rs`
- Modify: `apps/desktop/src-tauri/src/cfd/commands.rs`

- [ ] **Step 1: Write failing tests**

In `crates/cfd-core/src/dto.rs` `#[cfg(test)] mod tests`:
```rust
#[test]
fn loaded_config_camel_case_includes_is_example() {
    let lc = LoadedConfig {
        path: "x".into(),
        raw: serde_json::json!({}),
        summary: ConfigSummary { display_name: "x".into(), n_cylinders: 4, bore_mm: 0.0, stroke_mm: 0.0, compression_ratio: 0.0, displacement_l: 0.0, restrictor_throat_mm: 0.0, plenum_volume_l: 0.0 },
        is_example: true,
    };
    let s = serde_json::to_string(&lc).unwrap();
    assert!(s.contains("\"isExample\":true"), "{s}");
}
```

- [ ] **Step 2: Add the field to LoadedConfig**

Add `pub is_example: bool,` to the struct (already has `#[serde(rename_all = "camelCase")]`).

- [ ] **Step 3: Update commands.rs to compute is_example**

In `cfd_load_config`:
```rust
let resource_dir = ... // resolve via app.path().resource_dir() if app handle is available
let is_example = matches_resource_dir(&p, &resource_dir);
Ok(LoadedConfig { path, raw, summary, is_example })
```

Note: `cfd_load_config` currently doesn't take an `AppHandle`. Change its signature to:
```rust
pub fn cfd_load_config(app: tauri::AppHandle, path: String) -> Result<LoadedConfig, String>
```
Add a helper `is_inside(path: &Path, dir: &Path) -> bool` using `Path::starts_with` after canonicalizing both.

- [ ] **Step 4: Run cfd-core tests**

```bash
cargo test -p cfd-core dto::
```

Expected: pass.

- [ ] **Step 5: Verify desktop builds**

```bash
cargo check -p helios-desktop
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add crates/cfd-core/src/dto.rs apps/desktop/src-tauri/src/cfd/commands.rs
git commit -m "feat(cfd-core): add isExample flag to LoadedConfig"
```

### Task 2: cfd-core `save.rs` — pure save logic

**Files:**
- Create: `crates/cfd-core/src/save.rs`
- Modify: `crates/cfd-core/src/lib.rs`

- [ ] **Step 1: Write failing tests in save.rs**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn valid_sdm26() -> serde_json::Value {
        // Read the bundled sdm26.json from python_ref
        let p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../engine-sim/python_ref/configs/sdm26.json");
        let text = std::fs::read_to_string(p).unwrap();
        serde_json::from_str(&text).unwrap()
    }

    #[test]
    fn save_valid_config_writes_pretty_json_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("out.json");
        save_config(&target, &valid_sdm26()).unwrap();
        assert!(target.exists());
        assert!(!dir.path().join("out.json.tmp").exists(),
            ".tmp must not remain after atomic rename");
        let text = std::fs::read_to_string(&target).unwrap();
        assert!(text.contains("\n    \"cylinder\""), "expected 4-space indent: {text}");
    }

    #[test]
    fn save_rejects_invalid_config_with_engine_sim_error() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("out.json");
        let mut bad = valid_sdm26();
        bad.as_object_mut().unwrap().remove("cylinder");
        let err = save_config(&target, &bad).unwrap_err();
        assert!(err.to_lowercase().contains("cylinder"), "got {err}");
        assert!(!target.exists(), "file must not be written on validation failure");
    }
}
```

Add `tempfile = "3"` to `[dev-dependencies]` in `crates/cfd-core/Cargo.toml`.

- [ ] **Step 2: Implement save_config**

```rust
use std::fs;
use std::io::Write;
use std::path::Path;

pub fn save_config(path: &Path, raw: &serde_json::Value) -> Result<(), String> {
    // Validate via engine-sim using a temp file (its loader takes a path).
    let temp = tempfile::NamedTempFile::new()
        .map_err(|e| format!("create temp: {e}"))?;
    let text = serde_json::to_string_pretty(raw)
        .map_err(|e| format!("serialize: {e}"))?;
    // Pretty-print indent is 2 spaces by default; switch to 4 to match the bundled examples.
    let text = reindent_to_four(&text);
    fs::write(temp.path(), text.as_bytes()).map_err(|e| format!("write temp: {e}"))?;
    engine_sim::config::loader::load_v1_json(temp.path())
        .map_err(|e| format!("Schema error: {e}"))?;

    // Atomic write: same-dir .tmp then rename.
    let final_path = path;
    let tmp_path = path.with_extension("tmp");
    {
        let mut f = fs::File::create(&tmp_path).map_err(|e| format!("create {tmp_path:?}: {e}"))?;
        f.write_all(text.as_bytes()).map_err(|e| format!("write {tmp_path:?}: {e}"))?;
        f.sync_all().ok();
    }
    fs::rename(&tmp_path, final_path)
        .map_err(|e| format!("rename {tmp_path:?} -> {final_path:?}: {e}"))?;
    Ok(())
}

fn reindent_to_four(s: &str) -> String {
    // serde_json::to_string_pretty uses 2-space indent. The V1 examples
    // are saved at 4-space indent (see python_ref/configs/*.json). For
    // user-friendly diffs against the originals, match that.
    let mut out = String::with_capacity(s.len());
    for line in s.lines() {
        let indent = line.chars().take_while(|c| *c == ' ').count();
        let levels = indent / 2;
        for _ in 0..(levels * 4) { out.push(' '); }
        out.push_str(&line[indent..]);
        out.push('\n');
    }
    out
}
```

- [ ] **Step 3: Export from lib.rs**

```rust
pub mod save;
```

- [ ] **Step 4: Run tests**

```bash
cargo test -p cfd-core save::
```

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add crates/cfd-core/src/save.rs crates/cfd-core/src/lib.rs crates/cfd-core/Cargo.toml
git commit -m "feat(cfd-core): save_config — validate via engine-sim, atomic write"
```

### Task 3: Tauri command — cfd_save_config

**Files:**
- Modify: `apps/desktop/src-tauri/src/cfd/commands.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`

- [ ] **Step 1: Add the command**

```rust
#[tauri::command]
pub fn cfd_save_config(
    app: tauri::AppHandle,
    path: String,
    raw: serde_json::Value,
) -> Result<(), String> {
    let target = std::path::PathBuf::from(&path);
    // Reject writes inside the bundle's resource dir.
    if let Ok(resource_dir) = app.path().resource_dir() {
        if let Ok(canon_target) = target.canonicalize() {
            if let Ok(canon_resources) = resource_dir.canonicalize() {
                if canon_target.starts_with(&canon_resources) {
                    return Err("Cannot overwrite bundled example. Use Save-As to choose a user path.".into());
                }
            }
        }
    }
    cfd_core::save::save_config(&target, &raw)
}
```

- [ ] **Step 2: Add cfd_default_save_dir**

```rust
#[tauri::command]
pub fn cfd_default_save_dir(app: tauri::AppHandle) -> Result<String, String> {
    let docs = app.path().document_dir().map_err(|e| format!("document_dir: {e}"))?;
    let dir = docs.join("Helios").join("cfd").join("configs");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all {dir:?}: {e}"))?;
    Ok(dir.to_string_lossy().into_owned())
}
```

- [ ] **Step 3: Register in lib.rs**

Append to the `invoke_handler!` list:
```rust
cfd::commands::cfd_save_config,
cfd::commands::cfd_default_save_dir,
```

- [ ] **Step 4: Verify build**

```bash
cargo check -p helios-desktop
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/cfd/commands.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop/cfd): cfd_save_config + cfd_default_save_dir Tauri commands"
```

### Task 4: fs:write capability

**Files:**
- Modify: `apps/desktop/src-tauri/capabilities/default.json` (or whichever file declares fs scope)

- [ ] **Step 1: Locate the capability file**

```bash
find apps/desktop/src-tauri -name "*.json" -path "*capabilit*"
```

- [ ] **Step 2: Grant scope**

Add to the permissions list:
```json
{ "identifier": "fs:write-files", "allow": [{ "path": "$DOCUMENT/Helios/cfd/configs/**" }] },
{ "identifier": "fs:default" }
```

Note: depending on Tauri 2's exact capability schema, the spelling may differ. The right shape is: "allow `fs:write` for paths matching `$DOCUMENT/Helios/cfd/configs/**`". The `tauri::AppHandle`-based write in `cfd_save_config` is privileged regardless, so this is belt-and-suspenders. The plan author should read the existing `capabilities/*.json` to see what shape is already in use and follow that.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/capabilities/
git commit -m "chore(desktop): grant fs:write under $DOCUMENT/Helios/cfd/configs for Phase 2 saves"
```

---

## Wave B — Editor state + schema extension

### Task 5: Path helpers (immutable get/set)

**Files:**
- Create: `apps/desktop/src/modules/cfd/editor/lib/path-helpers.ts`
- Create: `apps/desktop/src/modules/cfd/__tests__/editor/path-helpers.test.ts`

- [ ] **Step 1: Tests**

```ts
import { describe, it, expect } from "vitest";
import { getAt, setAt } from "../../editor/lib/path-helpers";

describe("path helpers", () => {
  it("getAt reads nested values", () => {
    expect(getAt({ a: { b: 1 } }, "a.b")).toBe(1);
    expect(getAt({ a: { b: 1 } }, "a.c")).toBeUndefined();
  });
  it("setAt returns a new object with the value set, leaving the original untouched", () => {
    const o = { a: { b: 1 }, c: 2 };
    const r = setAt(o, "a.b", 99);
    expect(r).toEqual({ a: { b: 99 }, c: 2 });
    expect(o.a.b).toBe(1);
  });
  it("setAt creates intermediate objects", () => {
    expect(setAt({}, "a.b.c", 5)).toEqual({ a: { b: { c: 5 } } });
  });
  it("setAt supports numeric array indices", () => {
    const o = { items: [{ x: 1 }, { x: 2 }] };
    const r = setAt(o, "items.0.x", 99);
    expect((r as any).items[0].x).toBe(99);
    expect((r as any).items[1].x).toBe(2);
    expect(o.items[0]!.x).toBe(1);
  });
});
```

- [ ] **Step 2: Implement**

```ts
export function getAt(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export function setAt<T extends object>(obj: T, path: string, value: unknown): T {
  const parts = path.split(".");
  const root: any = Array.isArray(obj) ? [...obj] : { ...obj };
  let cur: any = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    const next = cur[k];
    if (Array.isArray(next)) cur[k] = [...next];
    else if (next && typeof next === "object") cur[k] = { ...next };
    else cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]!] = value;
  return root;
}

export function deleteAt<T extends object>(obj: T, path: string): T {
  const parts = path.split(".");
  if (parts.length === 1) {
    const next: any = { ...obj };
    delete next[parts[0]!];
    return next;
  }
  const head = parts.slice(0, -1).join(".");
  const parent = getAt(obj, head);
  if (parent == null || typeof parent !== "object") return obj;
  const nextParent: any = Array.isArray(parent) ? [...parent] : { ...parent };
  delete nextParent[parts[parts.length - 1]!];
  return setAt(obj, head, nextParent);
}
```

- [ ] **Step 3: Run tests + commit**

```bash
pnpm --filter @helios/desktop test -- editor/path-helpers
git add apps/desktop/src/modules/cfd/editor/lib/path-helpers.ts apps/desktop/src/modules/cfd/__tests__/editor/path-helpers.test.ts
git commit -m "feat(desktop/cfd): immutable dot-path get/set helpers"
```

### Task 6: deep-equal helper

**Files:**
- Create: `apps/desktop/src/modules/cfd/editor/lib/deep-equal.ts` (~10 lines, structural recursive equality)
- Inline test inside path-helpers.test.ts or its own file — choose one. Tests: object/array/scalar equality.

- [ ] **Step 1: Tests + implementation**

```ts
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    if (a.length !== bb.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], bb[i])) return false;
    return true;
  }
  const ak = Object.keys(a as object), bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (!deepEqual((a as any)[k], (b as any)[k])) return false;
  return true;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/modules/cfd/editor/lib/deep-equal.ts
git commit -m "feat(desktop/cfd): deepEqual structural equality"
```

### Task 7: Extend sdm26Schema.ts

**Files:**
- Modify: `apps/desktop/src/modules/cfd/lib/sdm26Schema.ts`

- [ ] **Step 1: Extend FieldMeta**

```ts
export type FieldType = "number" | "integer" | "text" | "select" | "boolean";

export interface FieldMeta {
  key: string;
  label: string;
  unit?: string;
  group: string;
  type: FieldType;
  format?: (v: unknown) => string;
  formatInverse?: (s: string) => unknown;
  min?: number;       // SI units
  max?: number;       // SI units
  step?: number;      // SI units (use a small step for SI-stored values)
  required?: boolean;
  options?: ReadonlyArray<{ value: string; label: string }>;
}
```

- [ ] **Step 2: Update every existing entry to include `type` + validation hints**

Examples:
```ts
{ key: "cylinder.bore", label: "Bore", unit: "mm", group: "Engine", type: "number",
  format: mm, formatInverse: (s) => Number(s) / 1000,
  min: 0.020, max: 0.150 },
{ key: "n_cylinders", label: "Cylinders", group: "Engine", type: "integer",
  format: f0, min: 1, max: 16, required: true },
{ key: "combustion.combustion_duration", label: "Duration", unit: "°CA", group: "Combustion",
  type: "number", format: f1, min: 1, max: 180, required: true },
// ...all 30+ fields
```

Add entries the Phase 1 schema omitted because they were null/optional: `combustion.afr_stoich`, etc.

Add a `TopologyMeta` entry under "Exhaust" group:
```ts
{ key: "__topology", label: "Exhaust topology", group: "Exhaust", type: "select",
  options: [{ value: "4-1", label: "4-1 (single collector)" }, { value: "4-2-1", label: "4-2-1 (with secondaries)" }] },
```

`__topology` is a synthetic key — the reducer treats writes to it specially (mutates the secondaries array).

- [ ] **Step 3: Add `valveSchema` and `pipeRowSchema` constants**

```ts
export const VALVE_FIELDS: FieldMeta[] = [
  { key: "diameter", label: "Ø", unit: "mm", group: "Valve", type: "number",
    format: mm, formatInverse: (s) => Number(s)/1000, min: 0.005, max: 0.060 },
  { key: "max_lift", label: "Max lift", unit: "mm", group: "Valve", type: "number",
    format: mm, formatInverse: (s) => Number(s)/1000, min: 0.001, max: 0.030 },
  { key: "open_angle", label: "Open angle", unit: "°", group: "Valve", type: "number",
    format: f1, min: -360, max: 720, required: true },
  { key: "close_angle", label: "Close angle", unit: "°", group: "Valve", type: "number",
    format: f1, min: -360, max: 720, required: true },
  { key: "seat_angle", label: "Seat angle", unit: "°", group: "Valve", type: "number",
    format: f1, min: 0, max: 90 },
];

export const PIPE_FIELDS: FieldMeta[] = [
  { key: "name", label: "Name", group: "Pipe", type: "text" },
  { key: "length", label: "L", unit: "mm", group: "Pipe", type: "number",
    format: mm, formatInverse: (s) => Number(s)/1000, min: 0.01, max: 5.0 },
  { key: "diameter", label: "Ø in", unit: "mm", group: "Pipe", type: "number",
    format: mm, formatInverse: (s) => Number(s)/1000, min: 0.005, max: 0.200 },
  { key: "diameter_out", label: "Ø out", unit: "mm", group: "Pipe", type: "number",
    format: (v) => v == null ? "—" : mm(v), formatInverse: (s) => s.trim() === "" || s.trim() === "—" ? null : Number(s)/1000,
    min: 0.005, max: 0.200 },
  { key: "n_points", label: "N cells", group: "Pipe", type: "integer", format: f0, min: 5, max: 200, required: true },
  { key: "wall_temperature", label: "T wall", unit: "K", group: "Pipe", type: "number", format: f0, min: 250, max: 1500 },
  { key: "roughness", label: "Roughness", unit: "m", group: "Pipe", type: "number", format: (v) => typeof v === "number" ? v.toExponential(1) : String(v), min: 0, max: 1e-3 },
];
```

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/modules/cfd/lib/sdm26Schema.ts
git commit -m "feat(desktop/cfd): extend FieldMeta with type/min/max/step/required + valve/pipe schemas"
```

### Task 8: Client validation rules

**Files:**
- Create: `apps/desktop/src/modules/cfd/editor/validation/client-rules.ts`
- Create: `apps/desktop/src/modules/cfd/__tests__/editor/client-rules.test.ts`

- [ ] **Step 1: Tests first**

```ts
import { validateField } from "../../editor/validation/client-rules";
import type { FieldMeta } from "../../lib/sdm26Schema";

const bore: FieldMeta = { key: "cylinder.bore", label: "Bore", group: "Engine", type: "number", min: 0.02, max: 0.15, required: true };

describe("validateField", () => {
  it("accepts in-range numbers", () => {
    expect(validateField(bore, 0.067)).toEqual({ ok: true });
  });
  it("rejects below min", () => {
    expect(validateField(bore, 0.01)).toMatchObject({ ok: false });
  });
  it("rejects NaN", () => {
    expect(validateField(bore, NaN)).toMatchObject({ ok: false });
  });
  it("rejects empty for required", () => {
    expect(validateField(bore, null)).toMatchObject({ ok: false });
    expect(validateField(bore, "")).toMatchObject({ ok: false });
  });
  it("integer rejects fractional", () => {
    const f = { key: "n", label: "N", group: "G", type: "integer" as const, required: true };
    expect(validateField(f, 4)).toEqual({ ok: true });
    expect(validateField(f, 4.5)).toMatchObject({ ok: false });
  });
});
```

- [ ] **Step 2: Implement validateField + validateAll**

```ts
export type ValidationResult = { ok: true } | { ok: false; message: string };

export function validateField(meta: FieldMeta, value: unknown): ValidationResult {
  if (value == null || value === "") {
    return meta.required ? { ok: false, message: `${meta.label} is required` } : { ok: true };
  }
  if (meta.type === "number" || meta.type === "integer") {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return { ok: false, message: `${meta.label} must be a number` };
    if (meta.type === "integer" && !Number.isInteger(n)) return { ok: false, message: `${meta.label} must be a whole number` };
    if (meta.min != null && n < meta.min) return { ok: false, message: `${meta.label} below minimum (${meta.min})` };
    if (meta.max != null && n > meta.max) return { ok: false, message: `${meta.label} above maximum (${meta.max})` };
  }
  if (meta.type === "select" && meta.options) {
    const ok = meta.options.some((o) => o.value === value);
    if (!ok) return { ok: false, message: `${meta.label} must be one of: ${meta.options.map((o) => o.value).join(", ")}` };
  }
  return { ok: true };
}

export function validateAll(
  metas: ReadonlyArray<FieldMeta>,
  raw: Record<string, unknown>,
  getAt: (obj: unknown, path: string) => unknown,
): Record<string, string> {
  const errs: Record<string, string> = {};
  for (const m of metas) {
    if (m.key.startsWith("__")) continue; // synthetic
    const v = getAt(raw, m.key);
    const r = validateField(m, v);
    if (!r.ok) errs[m.key] = r.message;
  }
  return errs;
}
```

- [ ] **Step 3: Run tests + commit**

```bash
pnpm --filter @helios/desktop test -- editor/client-rules
git add apps/desktop/src/modules/cfd/editor/validation/client-rules.ts apps/desktop/src/modules/cfd/__tests__/editor/client-rules.test.ts
git commit -m "feat(desktop/cfd): client-side field validation"
```

### Task 9: Editor reducer (editor-actions.ts)

**Files:**
- Create: `apps/desktop/src/modules/cfd/editor/state/editor-actions.ts`
- Create: `apps/desktop/src/modules/cfd/__tests__/editor/editor-actions.test.ts`

- [ ] **Step 1: Reducer tests**

```ts
import { editorReducer, initialEditorState, type EditorAction } from "../../editor/state/editor-actions";
import { makeLoadedConfig } from "../fakes/study";

describe("editorReducer", () => {
  it("setField updates draft immutably and clears resolved errors", () => {
    const s = { ...initialEditorState, draft: { a: 1 }, savedSnapshot: { a: 1 } };
    const next = editorReducer(s, { type: "setField", path: "a", value: 2 });
    expect(next.draft).toEqual({ a: 2 });
    expect(s.draft).toEqual({ a: 1 }); // immutable
  });
  it("isDirty(state) flips after first edit and resets after saveSucceeded", () => {
    // ...
  });
  it("loadTemplate replaces draft and sets savedSnapshot to {} so all fields are dirty", () => {
    // ...
  });
  it("addPipeRow appends a defaulted row to intake_pipes", () => {
    // ...
  });
  it("removePipeRow removes the index", () => {
    // ...
  });
  it("duplicatePipeRow inserts a copy after the index", () => {
    // ...
  });
  it("changeTopology to 4-1 deletes exhaust_secondaries", () => {
    // ...
  });
  it("changeTopology to 4-2-1 adds two defaulted secondaries", () => {
    // ...
  });
  it("saveSucceeded sets savedSnapshot, savedPath, isExample, clears errors", () => {
    // ...
  });
});
```

- [ ] **Step 2: Implement the reducer**

State + action union + reducer body. Key behaviors:
- `setField` uses `setAt` + recomputes `fieldErrors[path]` via `validateField`.
- `loadTemplate` replaces `draft`, sets `savedSnapshot = {}`, `savedPath = null`, `isExample = false`.
- `addPipeRow / removePipeRow / duplicatePipeRow` operate on `draft.<key>` where key is e.g. `intake_pipes`.
- `changeTopology` ensures `exhaust_secondaries` array length matches the topology.
- `saveSucceeded(path, isExample)` snapshots `draft` into `savedSnapshot`, sets fields, clears `globalError`.
- `setGlobalError(msg)` for engine-sim rejections.

Provide a helper `isDirty(state): boolean` using `deepEqual`.

Provide default factories:
```ts
export const DEFAULT_INTAKE_PIPE = { name: "", length: 0.245, diameter: 0.038, diameter_out: null, n_points: 30, wall_temperature: 325.0, roughness: 3e-5 };
export const DEFAULT_PRIMARY_PIPE = { name: "", length: 0.308, diameter: 0.032, diameter_out: null, n_points: 30, wall_temperature: 650.0, roughness: 4.6e-5 };
export const DEFAULT_SECONDARY_PIPE = { name: "", length: 0.392, diameter: 0.038, diameter_out: null, n_points: 20, wall_temperature: 550.0, roughness: 4.6e-5 };
```

- [ ] **Step 3: Run tests + commit**

```bash
pnpm --filter @helios/desktop test -- editor/editor-actions
git add apps/desktop/src/modules/cfd/editor/state/editor-actions.ts apps/desktop/src/modules/cfd/__tests__/editor/editor-actions.test.ts
git commit -m "feat(desktop/cfd): editor reducer with setField/template/pipe/topology actions"
```

---

## Wave C — Field primitives

### Task 10: NumberField

**Files:**
- Create: `apps/desktop/src/modules/cfd/editor/fields/NumberField.tsx`
- Create: `apps/desktop/src/modules/cfd/__tests__/editor/NumberField.test.tsx`

- [ ] **Step 1: Tests first**

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { NumberField } from "../../editor/fields/NumberField";

const meta = { key: "x", label: "Bore", group: "G", type: "number" as const,
  format: (v: unknown) => typeof v === "number" ? (v * 1000).toFixed(1) : "",
  formatInverse: (s: string) => Number(s) / 1000,
  min: 0.02, max: 0.15, unit: "mm" };

it("renders SI value 0.067 as '67.0'", () => {
  render(<NumberField meta={meta} value={0.067} error={null} onChange={() => {}} />);
  expect(screen.getByDisplayValue("67.0")).toBeInTheDocument();
});
it("calls onChange with SI value on blur", () => {
  const onChange = vi.fn();
  render(<NumberField meta={meta} value={0.067} error={null} onChange={onChange} />);
  const input = screen.getByDisplayValue("67.0");
  fireEvent.change(input, { target: { value: "70" } });
  fireEvent.blur(input);
  expect(onChange).toHaveBeenCalledWith(0.07);
});
it("renders error message", () => {
  render(<NumberField meta={meta} value={0.067} error="too small" onChange={() => {}} />);
  expect(screen.getByText("too small")).toBeInTheDocument();
});
```

- [ ] **Step 2: Implement**

```tsx
interface Props {
  meta: FieldMeta;
  value: unknown;
  error: string | null;
  onChange: (next: unknown) => void;
}

export function NumberField({ meta, value, error, onChange }: Props) {
  const [draft, setDraft] = useState(meta.format ? meta.format(value) : String(value ?? ""));
  useEffect(() => { setDraft(meta.format ? meta.format(value) : String(value ?? "")); }, [value, meta.format]);
  function commit() {
    if (draft === "") {
      onChange(null);
      return;
    }
    const next = meta.formatInverse ? meta.formatInverse(draft) : Number(draft);
    onChange(next);
  }
  const rangeHint = meta.min != null && meta.max != null
    ? `${meta.format ? meta.format(meta.min) : meta.min} – ${meta.format ? meta.format(meta.max) : meta.max}${meta.unit ? " " + meta.unit : ""}`
    : null;
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1">
        <input
          type="text"
          inputMode="decimal"
          aria-label={meta.label}
          className={
            "w-full rounded-sm border bg-[#0B0B0D] px-2 py-1 font-mono text-[11px] text-[#D8DCE2] focus:outline-none " +
            (error ? "border-red-500/60 focus:border-red-400" : "border-[#2A2C32] focus:border-[#FFC627]")
          }
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        />
        {meta.unit && <span className="text-[10px] text-[#5A5F66]">{meta.unit}</span>}
      </div>
      {error
        ? <div className="text-[10px] text-red-300">{error}</div>
        : rangeHint && <div className="text-[10px] text-[#5A5F66]">{rangeHint}</div>}
    </div>
  );
}
```

- [ ] **Step 3: Run tests + commit**

### Task 11: TextField + SelectField

**Files:** parallel — small components.

- [ ] **Step 1: Tests + implementations**

`TextField` is `NumberField` minus formatInverse/range; `SelectField` renders `<select>` from `meta.options`. Both follow the same chrome.

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/modules/cfd/editor/fields/TextField.tsx apps/desktop/src/modules/cfd/editor/fields/SelectField.tsx ...
git commit -m "feat(desktop/cfd): TextField + SelectField primitives"
```

### Task 12: CdTableField (with live plot)

**Files:**
- Create: `apps/desktop/src/modules/cfd/editor/fields/CdTableField.tsx`
- Create: `apps/desktop/src/modules/cfd/__tests__/editor/CdTableField.test.tsx`

- [ ] **Step 1: Tests**

```tsx
it("renders one row per cd_table entry", () => {
  render(<CdTableField value={[[0.05, 0.19], [0.1, 0.38]]} onChange={() => {}} />);
  expect(screen.getAllByRole("row")).toHaveLength(3); // header + 2 rows
});
it("Add adds a row defaulted to last L/D + 0.05, last Cd", () => { ... });
it("Remove disables when only 2 rows remain", () => { ... });
it("auto-sorts by L/D on edit", () => { ... });
```

- [ ] **Step 2: Implementation**

- Table with two columns (L/D, Cd) and a Remove button per row.
- Below: an inline `CdCurvePlot` using uPlot that subscribes to `value`.
- "Add row" button.
- Edits sort the rows by L/D and call `onChange(newRows)`.
- Monotonicity warning: a yellow inline message if `Cd[i+1] < Cd[i] - 0.05` for any i.

- [ ] **Step 3: Commit**

### Task 13: PipeArrayField

**Files:**
- Create: `apps/desktop/src/modules/cfd/editor/fields/PipeArrayField.tsx`
- Create: `apps/desktop/src/modules/cfd/__tests__/editor/PipeArrayField.test.tsx`

- [ ] **Step 1: Tests**

- Renders N rows = `value.length`.
- Duplicate inserts a copy with name suffixed " (copy)".
- Remove drops the index; refuses if only 1 row remains (visible "min 1").
- Edit-cell propagates through `onChange(newRows)`.

- [ ] **Step 2: Implementation**

Compact table — each cell is an inline editable input. Per-row actions: duplicate, remove. Footer: "Add pipe" button.

- [ ] **Step 3: Commit**

### Task 14: FiringOrderField

**Files:**
- Create: `apps/desktop/src/modules/cfd/editor/fields/FiringOrderField.tsx`

- [ ] **Step 1: Tests**

- Renders N slots reflecting `value`.
- Up/down arrows reorder.
- Validation: must contain 1..N exactly once each.

- [ ] **Step 2: Implementation + commit**

---

## Wave D — Composition

### Task 15: editor-context.tsx wrap + ConfigScreen rewrite

**Files:**
- Create: `apps/desktop/src/modules/cfd/editor/state/editor-context.tsx`
- Rewrite: `apps/desktop/src/modules/cfd/screens/ConfigScreen.tsx`

- [ ] **Step 1: editor-context.tsx**

```tsx
const EditorCtx = createContext<EditorContextValue | null>(null);

export function useEditor() {
  const v = useContext(EditorCtx);
  if (!v) throw new Error("useEditor must be inside <EditorProvider>");
  return v;
}

export function EditorProvider({ children }: { children: ReactNode }) {
  const { state: cfdState, setLoadedConfig, bridge } = useCfd();
  const [state, dispatch] = useReducer(editorReducer, initialEditorState);
  // When CfdContext.loadedConfig changes, reset editor.
  useEffect(() => {
    if (cfdState.loadedConfig) {
      dispatch({ type: "loadFromConfig", config: cfdState.loadedConfig });
    } else {
      dispatch({ type: "reset" });
    }
  }, [cfdState.loadedConfig]);

  const save = async (saveAs: boolean) => {
    let path = state.savedPath;
    if (saveAs || !path || state.isExample) {
      const defaultDir = await bridge.defaultSaveDir();
      const picked = await openSaveDialog({ defaultPath: path ?? defaultDir + "/config.json", filters: [{ name: "Engine config", extensions: ["json"] }] });
      if (!picked) return;
      path = picked;
    }
    try {
      await bridge.saveConfig(path, state.draft);
      dispatch({ type: "saveSucceeded", path, isExample: false });
      setLoadedConfig({ path, raw: state.draft, summary: cfdState.loadedConfig?.summary ?? /* compute */, isExample: false });
    } catch (e) {
      dispatch({ type: "setGlobalError", message: e instanceof Error ? e.message : String(e) });
    }
  };

  return <EditorCtx.Provider value={{ state, dispatch, save, isDirty: isDirty(state) }}>{children}</EditorCtx.Provider>;
}
```

- [ ] **Step 2: ConfigScreen rewrite**

The new ConfigScreen wraps everything in `<EditorProvider>` (above `<ConfigScreenBody>`), reads from `useEditor()`, and renders:

Header strip:
```tsx
<header>
  <h1>Engine config</h1>
  <PathLabel path={state.savedPath ?? "(unsaved)"} dirty={isDirty} />
  <button onClick={openTemplatePicker}>New…</button>
  <button onClick={openFile}>Open…</button>
  <Dropdown label="Examples ▾" items={examples} />
  <button onClick={openDiff}>Diff…</button>
  {isDirty && <button onClick={discard}>Discard</button>}
  <button onClick={() => save(false)} disabled={!isDirty || state.isExample}>Save</button>
  <button onClick={() => save(true)} disabled={!isDirty}>Save As…</button>
</header>
```

Body:
```tsx
{state.globalError && <ValidationBanner message={state.globalError} />}

<div className="grid lg:grid-cols-2 gap-2 p-2">
  {SDM26_GROUPS.map((g) => (
    <Section title={g} key={g}>
      {SDM26_SCHEMA.filter((f) => f.group === g).map((m) => (
        <FieldRow meta={m} key={m.key}>
          <DispatchField meta={m} />
        </FieldRow>
      ))}
    </Section>
  ))}
  <CdSection title="Intake valve Cd" value={getAt(draft, "intake_valve.cd_table")} onChange={(v) => dispatch({ type: "setField", path: "intake_valve.cd_table", value: v })} />
  <CdSection title="Exhaust valve Cd" value={getAt(draft, "exhaust_valve.cd_table")} onChange={(v) => dispatch({ type: "setField", path: "exhaust_valve.cd_table", value: v })} />
  <PipeSection title="Intake runners" path="intake_pipes" />
  <PipeSection title="Exhaust primaries" path="exhaust_primaries" />
  {hasSecondaries && <PipeSection title="Exhaust secondaries" path="exhaust_secondaries" />}
</div>
```

`DispatchField` switches on `meta.type` to render NumberField / TextField / SelectField. Special-cases the synthetic `__topology` key by reading current topology from `draft.exhaust_secondaries?.length`.

- [ ] **Step 3: Tests + commit**

### Task 16: Keyboard shortcuts + dirty-leave confirmation

**Files:**
- Modify: `apps/desktop/src/modules/cfd/CfdHome.tsx`

- [ ] **Step 1: Wire Ctrl+S / Ctrl+Shift+S**

In `CfdShell` (or a small hook), `useEffect` registering keydown listeners that call `editor.save(false/true)` when the CFD module is active.

- [ ] **Step 2: Discard-confirm on nav while dirty**

In `CfdContext.navigateTo`, guard with a check: if `editor.isDirty && next !== current`, open a `ConfirmModal` and only proceed if confirmed. Reuse Phase 1's ConfirmModal.

- [ ] **Step 3: Commit**

---

## Wave E — Templates + Diff

### Task 17: templates.ts + TemplatePickerModal

**Files:**
- Create: `apps/desktop/src/modules/cfd/editor/templates/templates.ts`
- Create: `apps/desktop/src/modules/cfd/editor/templates/TemplatePickerModal.tsx`
- Create: `apps/desktop/src/modules/cfd/__tests__/editor/templates.test.ts`

- [ ] **Step 1: templates.ts**

Three exports: `SDM26_TEMPLATE`, `SDM25_TEMPLATE`, `BLANK_TEMPLATE`. Materialized as `Record<string, unknown>` matching the V1 JSON schema. Source SDM26 and SDM25 by importing the bundled JSON via Vite's `?raw` (or `import { default as cfg } from "./sdm26.json"`); store them as deep-frozen objects.

Blank template: minimal valid SDM26 (`name: "New engine"`, defaults).

- [ ] **Step 2: Test that every template parses through engine-sim**

Done by a Rust test (Task 22 manual-smoke covers it). For TS-side test: assert presence of required top-level keys.

- [ ] **Step 3: TemplatePickerModal**

Modal: three rows (SDM26, SDM25, Blank). Each: name + 1-liner description. Click → `dispatch({ type: "loadTemplate", template })` and close.

- [ ] **Step 4: Commit**

### Task 18: diff-engine.ts

**Files:**
- Create: `apps/desktop/src/modules/cfd/editor/diff/diff-engine.ts`
- Create: `apps/desktop/src/modules/cfd/__tests__/editor/diff-engine.test.ts`

- [ ] **Step 1: Tests**

```ts
it("identifies a changed scalar", () => {
  const a = { cylinder: { bore: 0.067 } };
  const b = { cylinder: { bore: 0.070 } };
  const d = diffConfigs(a, b, SDM26_SCHEMA);
  const bore = d.find((e) => e.key === "cylinder.bore");
  expect(bore?.kind).toBe("changed");
  expect(bore?.left).toBe(0.067);
  expect(bore?.right).toBe(0.070);
});
it("flags equal-valued fields as same", () => { ... });
it("flags missing-in-right as removed", () => { ... });
```

- [ ] **Step 2: Implementation**

Walk SDM26_SCHEMA + descend known array fields (intake_pipes etc.) to produce a flat list of entries `{ group, key, left, right, kind }`.

- [ ] **Step 3: Commit**

### Task 19: ConfigDiffModal

**Files:**
- Create: `apps/desktop/src/modules/cfd/editor/diff/ConfigDiffModal.tsx`

- [ ] **Step 1: UI**

Modal:
- Header: "Compare against…" + radio (last-saved | current draft) only when dirty.
- File picker / examples dropdown.
- Once a second source loads (via `cfdApi.loadConfig`), render the diff result grouped by `group`, with changed fields highlighted yellow, identical fields dim. Sections with 0 changes collapse to a single line.

- [ ] **Step 2: Commit**

---

## Wave F — Verification

### Task 20: Full test suite + typecheck

- [ ] **Step 1:**

```bash
cargo test -p engine-sim -p cfd-core
pnpm --filter @helios/desktop typecheck
pnpm --filter @helios/desktop test
```

Expected: all green. Frontend test count grew by ~20+ from the new editor tests.

### Task 21: Manual smoke

- [ ] **Smoke 1 — Edit + Save-As an example:** Load SDM26 example → Bore 67 → 70 mm → Save (forced Save-As) → reopen → bore is 70.
- [ ] **Smoke 2 — New from template:** New → Blank → Save-As → re-run Phase 1 sim → produces sensible numbers (no NaN, IMEP > 0).
- [ ] **Smoke 3 — Topology switch:** Switch 4-2-1 → 4-1 (confirm) → secondaries gone → Save → re-run sim → ok.
- [ ] **Smoke 4 — Diff:** Edit bore → Diff vs SDM26 example → bore row highlighted.
- [ ] **Smoke 5 — Validation:** Bore = -1 → red field error → Save blocked.
- [ ] **Smoke 6 — Server validation:** Compression ratio 0.5 (passes client) → engine-sim banner appears → Save blocked.

### Task 22: Final commit + branch summary

- [ ] `git log --oneline origin/main..HEAD` — verify clean commit chain.
- [ ] Add a `v2_changes/35-cfd-config-editor.md` entry per the project's [[v2-changes-log]] memory.

---

## Out of scope (do NOT do in Phase 2)

- Multi-step undo/redo.
- Drag-to-reorder for firing-order (up/down arrows ship; drag is later polish).
- Schema migrations (V1 → V2).
- Editing arbitrary JSON outside SDM schema.
- Anything in Phase 3-5 of the spec.

## Notes for the executor

- TDD per file. Write the test, run it, see it fail, then implement, watch it pass.
- Commit per task.
- Match the Logs styling Phase 1's restyle pass established (`#0E0E10` / `#0B0B0D` / `#16171B` / `#2A2C32` / `#FFC627`).
- No `window.alert/confirm/prompt` — reuse `ConfirmModal`.
- No Python file additions.
- If a parity test breaks during the editor work: stop, investigate. The math is unchanged in Phase 2; any drift is a serialization bug.
- The spec is at `docs/superpowers/specs/2026-05-21-cfd-tab-phase-2-design.md`; cross-reference when in doubt.
