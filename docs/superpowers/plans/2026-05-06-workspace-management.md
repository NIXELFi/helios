# Workspace Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make workspaces first-class user-managed objects — create, rename, color, duplicate, drag-reorder, delete — and add JSON export/import bundles so workspaces can be shared by email. Replace the app's last `window.confirm()` with a custom dialog along the way.

**Architecture:** Lift workspace CRUD into a new `<WorkspaceTabBar>` component that owns the tab strip, the right-click `<TabContextMenu>`, and inline-rename + drag-reorder. Add a reusable `<ConfirmDialog>` that supports both confirm and alert modes. Persist via the existing `localStorage` flow with a v1→v2 migration adding a `color` field. Bundle export/import goes through three pure functions (`serializeBundle`, `parseBundle`, `mergeImported`) plus a thin Tauri dialog wrapper. No new state library; all callbacks funnel through the existing `commitWorkspaces` helper in `App.tsx`.

**Tech Stack:** React 18 + TypeScript, Tailwind, Vitest + jsdom + `@testing-library/react`, Tauri 2 (`@tauri-apps/plugin-dialog`, `tauri-plugin-dialog` crate). HTML5 native drag-and-drop. No DnD or UI-primitive libraries.

**Spec:** [docs/superpowers/specs/2026-05-06-workspace-management-design.md](../specs/2026-05-06-workspace-management-design.md)

---

## File Structure

### New files

```
apps/desktop/
  src/
    components/
      WorkspaceTabBar.tsx       ← tab strip + buttons + drag-reorder + inline rename
      TabContextMenu.tsx        ← right-click menu (Rename / Color ▸ / Duplicate / Export / Delete)
      ConfirmDialog.tsx         ← reusable modal; supports alert mode (no cancel button)
    lib/
      workspace-bundle.ts       ← serializeBundle / parseBundle / mergeImported / slugify (pure)
      workspace-dialog.ts       ← thin wrappers around Tauri's plugin-dialog save() / open()
  src-tauri/
    capabilities/
      default.json              ← +"dialog:default"
    src/
      lib.rs                    ← register tauri_plugin_dialog
    Cargo.toml                  ← +tauri-plugin-dialog
  tests/
    setup.ts                    ← matchMedia stub for jsdom (component tests)
    workspace-storage.test.ts
    workspace-bundle.test.ts
    ConfirmDialog.test.tsx
    TabContextMenu.test.tsx
    WorkspaceTabBar.test.tsx
  vitest.config.ts              ← jsdom env + setupFiles

v2_changes/
  25-workspace-management.md
  README.md                     ← +entry
```

### Modified files

```
apps/desktop/
  package.json                                  ← +deps (RTL, jsdom, jest-dom, plugin-dialog)
  src/
    App.tsx                                     ← swap inline tabs for <WorkspaceTabBar>;
                                                   add confirmState + new callbacks; render
                                                   <ConfirmDialog> slot; remove window.confirm()
    workspaces/
      types.ts                                  ← add `color: string` to Workspace
      index.ts                                  ← add colors to built-ins
      overview-default.ts                       ← (no change — tiles only)
      engine-focus.ts                           ← (no change — tiles only)
    lib/
      workspace-storage.ts                      ← v1→v2 migration adding color
      session.ts                                ← (no change — re-exporting SESSION_PALETTE)

apps/desktop/src-tauri/tauri.conf.json          ← bump version 2.3.0 → 2.3.2 (via bump script)
package.json                                    ← bump root version 2.3.0 → 2.3.2
Cargo.toml                                      ← bump workspace version 2.3.0 → 2.3.2
```

### Files NOT touched

Math channels, session loading, individual widgets, the loading screen, the updater. This work is scoped to the header tab strip + persistence + a new dialog component.

---

## Conventions used throughout

- **One TDD cycle per logical unit:** failing test → run-and-confirm-fail → minimal impl → run-and-confirm-pass → commit. Pure functions and reducers go first; components last.
- **Commit cadence:** at least once per task (sometimes twice — once after tests-and-types are green, once after wiring). Keep messages in the existing style (`feat(...)`, `test(...)`, `refactor(...)`, `chore(...)`).
- **Test colocation:** All new tests live in `apps/desktop/tests/` (mirroring the existing `apps/desktop/tests/vector-ops.test.ts`).
- **Run the test suite as `pnpm --filter @helios/desktop test`** — that's the existing script in `apps/desktop/package.json`.
- **Run the typecheck as `pnpm --filter @helios/desktop typecheck`** — also already in scripts.
- **Don't add `window.confirm()` / `alert()` / `prompt()` anywhere.** When migrating existing usages, switch them to `<ConfirmDialog>` in the same change.

---

## Phase 0 — Test plumbing & dependencies

The `apps/desktop` package currently has one Node-env unit test (`vector-ops.test.ts`) and no jsdom config. We need jsdom + React Testing Library to write component tests for the new UI.

### Task 0.1: Add JS dependencies

**Files:**
- Modify: `apps/desktop/package.json`

- [ ] **Step 1: Add the new deps**

```bash
pnpm --filter @helios/desktop add @tauri-apps/plugin-dialog@^2.0.0
pnpm --filter @helios/desktop add -D @testing-library/react@^16.0.0 @testing-library/jest-dom@^6.0.0 jsdom@^25.0.0
```

Expected: `package.json` updated, `pnpm-lock.yaml` updated, no install errors.

- [ ] **Step 2: Verify the workspace still installs cleanly**

Run: `pnpm install`
Expected: clean install, no peer-dep warnings beyond the existing ones.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/package.json pnpm-lock.yaml
git commit -m "chore(desktop): add plugin-dialog + RTL/jsdom test deps"
```

### Task 0.2: Wire Tauri `plugin-dialog` (Rust side)

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/capabilities/default.json`

- [ ] **Step 1: Add the crate**

In `apps/desktop/src-tauri/Cargo.toml` under `[dependencies]`, append:

```toml
tauri-plugin-dialog = "2"
```

- [ ] **Step 2: Register the plugin in `lib.rs`**

In `apps/desktop/src-tauri/src/lib.rs`, modify the builder chain so it reads:

```rust
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::load_csv::load_csv,
            commands::restart::helios_relaunch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Helios");
}
```

- [ ] **Step 3: Grant the dialog capability**

In `apps/desktop/src-tauri/capabilities/default.json`, append `"dialog:default"` to the `permissions` array (after `"updater:default"`).

- [ ] **Step 4: Verify Rust still compiles**

Run: `pnpm --filter @helios/desktop build` (or `cd apps/desktop/src-tauri && cargo check`)
Expected: clean compile.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/capabilities/default.json Cargo.lock
git commit -m "chore(desktop): register tauri-plugin-dialog + grant capability"
```

### Task 0.3: Add jsdom vitest config + test setup

**Files:**
- Create: `apps/desktop/vitest.config.ts`
- Create: `apps/desktop/tests/setup.ts`
- Modify: `apps/desktop/tests/vector-ops.test.ts` (verify still passes — should require no change since vitest auto-uses node env if not specified, but jsdom is fine for it too)

- [ ] **Step 1: Create the vitest config**

`apps/desktop/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.{ts,tsx}"],
    setupFiles: ["tests/setup.ts"],
  },
  resolve: {
    alias: {
      "@helios/store": path.resolve(__dirname, "../../packages/store/src"),
      "@helios/lib": path.resolve(__dirname, "../../packages/lib/src"),
      "@helios/ui": path.resolve(__dirname, "../../packages/ui/src"),
      "@helios/widgets": path.resolve(__dirname, "../../packages/widgets/src"),
    },
  },
});
```

- [ ] **Step 2: Create the test setup file**

`apps/desktop/tests/setup.ts`:

```ts
import "@testing-library/jest-dom/vitest";

// jsdom does not implement matchMedia; stub it for any code that touches it.
if (typeof window !== "undefined" && !window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (_query: string) => ({
      matches: false, media: _query, onchange: null,
      addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// crypto.randomUUID is available in modern jsdom; nothing to stub today.
```

- [ ] **Step 3: Confirm existing test still passes**

Run: `pnpm --filter @helios/desktop test`
Expected: `vector-ops.test.ts` passes (it doesn't touch DOM, jsdom is harmless).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/vitest.config.ts apps/desktop/tests/setup.ts
git commit -m "test(desktop): add jsdom vitest config + RTL setup"
```

---

## Phase 1 — Data model + storage migration

### Task 1.1: Add `color` field to `Workspace` type

**Files:**
- Modify: `apps/desktop/src/workspaces/types.ts`

- [ ] **Step 1: Add the field**

In `apps/desktop/src/workspaces/types.ts`, change the `Workspace` interface to:

```ts
export interface Workspace {
  id: string;
  label: string;
  color: string;  // hex string from SESSION_PALETTE (lib/session.ts)
  tiles: TileSpec[];
}
```

- [ ] **Step 2: Verify typecheck — should fail**

Run: `pnpm --filter @helios/desktop typecheck`
Expected: ERRORS in `apps/desktop/src/workspaces/index.ts` (built-ins missing `color`) and in `apps/desktop/src/lib/workspace-storage.ts`'s clone path (the cloned blob now has the field but the migration logic doesn't fill it for v1 blobs — surfaces in Task 1.4).

This is the desired pre-state for Task 1.2.

### Task 1.2: Color the built-in workspaces

**Files:**
- Modify: `apps/desktop/src/workspaces/index.ts`

- [ ] **Step 1: Add explicit colors to the built-ins**

```ts
import type { Workspace } from "./types";
import { overviewDefault } from "./overview-default";
import { engineFocus } from "./engine-focus";

export type { TileSpec, WidgetType, Workspace } from "./types";

export const WORKSPACES: Workspace[] = [
  { id: "overview",     label: "Overview",     color: "#FFC627", tiles: overviewDefault },
  { id: "engine-focus", label: "Engine focus", color: "#EF5350", tiles: engineFocus },
];
```

- [ ] **Step 2: Verify built-in typecheck error is now resolved**

Run: `pnpm --filter @helios/desktop typecheck`
Expected: errors in `index.ts` gone; `workspace-storage.ts` is still fine because v1 blobs are migrated at runtime, not compile time. If you see remaining errors anywhere, stop and re-read.

- [ ] **Step 3: Commit (combined with Task 1.1)**

```bash
git add apps/desktop/src/workspaces/types.ts apps/desktop/src/workspaces/index.ts
git commit -m "feat(workspaces): add color field; built-ins use yellow + red"
```

### Task 1.3: Write storage-migration tests

**Files:**
- Create: `apps/desktop/tests/workspace-storage.test.ts`

- [ ] **Step 1: Write the tests**

`apps/desktop/tests/workspace-storage.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { loadWorkspaces, saveWorkspaces } from "../src/lib/workspace-storage";
import { SESSION_PALETTE } from "../src/lib/session";

const KEY = "helios.workspaces.v1";

describe("workspace-storage", () => {
  beforeEach(() => localStorage.clear());

  it("seeds built-ins on first load (no blob)", () => {
    const ws = loadWorkspaces();
    expect(ws.length).toBeGreaterThan(0);
    expect(ws.every((w) => typeof w.color === "string" && w.color.startsWith("#"))).toBe(true);
  });

  it("v1→v2 migration fills color from SESSION_PALETTE indexed by position", () => {
    const v1 = {
      version: 1,
      workspaces: [
        { id: "a", label: "A", tiles: [] },
        { id: "b", label: "B", tiles: [] },
        { id: "c", label: "C", tiles: [] },
      ],
    };
    localStorage.setItem(KEY, JSON.stringify(v1));

    const ws = loadWorkspaces();

    expect(ws.map((w) => w.color)).toEqual([
      SESSION_PALETTE[0],
      SESSION_PALETTE[1],
      SESSION_PALETTE[2],
    ]);
    // The blob is rewritten as v2 in the same key.
    const rewritten = JSON.parse(localStorage.getItem(KEY)!);
    expect(rewritten.version).toBe(2);
  });

  it("v2 blob is loaded as-is (round-trip preserves color)", () => {
    const ws = [
      { id: "a", label: "A", color: "#123456", tiles: [] },
      { id: "b", label: "B", color: "#abcdef", tiles: [] },
    ];
    saveWorkspaces(ws);
    const loaded = loadWorkspaces();
    expect(loaded).toEqual(ws);
  });

  it("corrupt blob falls back to seeded built-ins", () => {
    localStorage.setItem(KEY, "not json {{{");
    const ws = loadWorkspaces();
    expect(ws.length).toBeGreaterThan(0);
    expect(ws[0]!.color).toMatch(/^#/);
  });

  it("empty workspaces array in stored blob falls back to built-ins", () => {
    localStorage.setItem(KEY, JSON.stringify({ version: 2, workspaces: [] }));
    const ws = loadWorkspaces();
    expect(ws.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run — they should fail**

Run: `pnpm --filter @helios/desktop test`
Expected: failures around v1 migration (color is `undefined`) and the v2 round-trip (since `saveWorkspaces` still writes `version: 1`). Confirm the *kind* of failure matches what you'd expect from un-migrated code.

### Task 1.4: Implement v1→v2 migration

**Files:**
- Modify: `apps/desktop/src/lib/workspace-storage.ts`

- [ ] **Step 1: Update the storage module**

Replace `apps/desktop/src/lib/workspace-storage.ts` with:

```ts
import type { Workspace } from "../workspaces/types";
import { WORKSPACES as BUILTIN_WORKSPACES } from "../workspaces";
import { SESSION_PALETTE } from "./session";

// localStorage key stays "helios.workspaces.v1" for backward-compat;
// only the in-blob `version` field changes.
const STORAGE_KEY = "helios.workspaces.v1";
const CURRENT_VERSION = 2;

interface StoredV1 {
  version: 1;
  workspaces: Array<Omit<Workspace, "color">>;
}
interface StoredV2 {
  version: 2;
  workspaces: Workspace[];
}
type Stored = StoredV1 | StoredV2;

/** Load workspaces from localStorage, falling back to (and seeding) the
 *  built-ins on first use or when the saved blob is unreadable. v1 blobs
 *  are migrated to v2 in-place by filling color from SESSION_PALETTE. */
export function loadWorkspaces(): Workspace[] {
  if (typeof localStorage === "undefined") return cloneBuiltins();
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    const seeded = cloneBuiltins();
    saveWorkspaces(seeded);
    return seeded;
  }
  try {
    const parsed = JSON.parse(raw) as Stored;
    if (!parsed || !Array.isArray(parsed.workspaces) || parsed.workspaces.length === 0) {
      throw new Error("malformed");
    }
    if (parsed.version === CURRENT_VERSION) {
      return parsed.workspaces;
    }
    if (parsed.version === 1) {
      const migrated: Workspace[] = parsed.workspaces.map((w, i) => ({
        ...w,
        color: SESSION_PALETTE[i % SESSION_PALETTE.length]!,
      }));
      saveWorkspaces(migrated);
      return migrated;
    }
  } catch {
    // fall through to seed
  }
  const seeded = cloneBuiltins();
  saveWorkspaces(seeded);
  return seeded;
}

/** Persist the current workspaces array as v2. */
export function saveWorkspaces(workspaces: Workspace[]): void {
  if (typeof localStorage === "undefined") return;
  const state: StoredV2 = { version: 2, workspaces };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

/** Replace the stored workspaces with a fresh copy of the bundled built-ins.
 *  Returns the new array so callers can update state. */
export function resetToBuiltins(): Workspace[] {
  const fresh = cloneBuiltins();
  saveWorkspaces(fresh);
  return fresh;
}

function cloneBuiltins(): Workspace[] {
  return JSON.parse(JSON.stringify(BUILTIN_WORKSPACES)) as Workspace[];
}
```

- [ ] **Step 2: Run tests**

Run: `pnpm --filter @helios/desktop test`
Expected: `workspace-storage.test.ts` all green; `vector-ops.test.ts` still green.

- [ ] **Step 3: Run typecheck**

Run: `pnpm --filter @helios/desktop typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/lib/workspace-storage.ts apps/desktop/tests/workspace-storage.test.ts
git commit -m "feat(workspaces): v2 storage migration adds color field"
```

---

## Phase 2 — Workspace bundle (pure functions)

These are testable in isolation, no DOM required. Build them first, then components consume them.

### Task 2.1: Slugify helper

**Files:**
- Create: `apps/desktop/src/lib/workspace-bundle.ts` (start it here; we'll add to it)

- [ ] **Step 1: Write the failing test**

In `apps/desktop/tests/workspace-bundle.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { slugifyForFilename } from "../src/lib/workspace-bundle";

describe("slugifyForFilename", () => {
  it("lowercases and dashes spaces", () => {
    expect(slugifyForFilename("Driver Tryout")).toBe("driver-tryout");
  });
  it("collapses runs of non-alphanumerics", () => {
    expect(slugifyForFilename("SDM26  ---  best!!  accel")).toBe("sdm26-best-accel");
  });
  it("trims leading/trailing dashes", () => {
    expect(slugifyForFilename("  --hello--  ")).toBe("hello");
  });
  it("falls back to 'workspace' for empty/all-symbol input", () => {
    expect(slugifyForFilename("")).toBe("workspace");
    expect(slugifyForFilename("///---")).toBe("workspace");
  });
});
```

- [ ] **Step 2: Run — it should fail (module missing)**

Run: `pnpm --filter @helios/desktop test`
Expected: import error.

- [ ] **Step 3: Implement**

`apps/desktop/src/lib/workspace-bundle.ts`:

```ts
export function slugifyForFilename(label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug || "workspace";
}
```

- [ ] **Step 4: Run — green**

Run: `pnpm --filter @helios/desktop test`

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/workspace-bundle.ts apps/desktop/tests/workspace-bundle.test.ts
git commit -m "feat(workspaces): slugify helper for export filenames"
```

### Task 2.2: `serializeBundle`

**Files:**
- Modify: `apps/desktop/src/lib/workspace-bundle.ts`
- Modify: `apps/desktop/tests/workspace-bundle.test.ts`

- [ ] **Step 1: Write tests for `serializeBundle`**

Append to `workspace-bundle.test.ts`:

```ts
import { serializeBundle, BUNDLE_KIND, BUNDLE_VERSION } from "../src/lib/workspace-bundle";
import type { Workspace } from "../src/workspaces/types";

const sampleWs: Workspace[] = [
  { id: "a", label: "A", color: "#FFC627", tiles: [] },
];

describe("serializeBundle", () => {
  it("produces a JSON string with the documented shape", () => {
    const json = serializeBundle(sampleWs, "1.2.3");
    const parsed = JSON.parse(json);
    expect(parsed.kind).toBe(BUNDLE_KIND);
    expect(parsed.version).toBe(BUNDLE_VERSION);
    expect(parsed.exportedFrom).toBe("Helios 1.2.3");
    expect(typeof parsed.exportedAt).toBe("string");
    expect(new Date(parsed.exportedAt).toString()).not.toBe("Invalid Date");
    expect(parsed.workspaces).toEqual(sampleWs);
  });

  it("does not mutate input workspaces", () => {
    const before = JSON.parse(JSON.stringify(sampleWs));
    serializeBundle(sampleWs, "x");
    expect(sampleWs).toEqual(before);
  });
});
```

- [ ] **Step 2: Run — fail (`serializeBundle` not exported)**

- [ ] **Step 3: Implement**

Add to `workspace-bundle.ts`:

```ts
import type { Workspace } from "../workspaces/types";

export const BUNDLE_KIND = "helios-workspace-bundle";
export const BUNDLE_VERSION = 1 as const;

export interface WorkspaceBundle {
  kind: typeof BUNDLE_KIND;
  version: typeof BUNDLE_VERSION;
  exportedAt: string;     // ISO timestamp
  exportedFrom: string;   // "Helios <semver>"
  workspaces: Workspace[];
}

export function serializeBundle(workspaces: Workspace[], appVersion: string): string {
  const bundle: WorkspaceBundle = {
    kind: BUNDLE_KIND,
    version: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    exportedFrom: `Helios ${appVersion}`,
    workspaces: JSON.parse(JSON.stringify(workspaces)),
  };
  return JSON.stringify(bundle, null, 2);
}
```

- [ ] **Step 4: Run — green; commit**

```bash
git add apps/desktop/src/lib/workspace-bundle.ts apps/desktop/tests/workspace-bundle.test.ts
git commit -m "feat(workspaces): serializeBundle for export"
```

### Task 2.3: `parseBundle`

- [ ] **Step 1: Write tests covering each rejection class**

Append to `workspace-bundle.test.ts`:

```ts
import { parseBundle } from "../src/lib/workspace-bundle";

describe("parseBundle", () => {
  const validBundle = JSON.stringify({
    kind: BUNDLE_KIND,
    version: BUNDLE_VERSION,
    exportedAt: "2026-05-06T00:00:00.000Z",
    exportedFrom: "Helios 2.3.2",
    workspaces: [{ id: "a", label: "A", color: "#FFC627", tiles: [] }],
  });

  it("accepts a well-formed bundle", () => {
    const r = parseBundle(validBundle);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bundle.workspaces.length).toBe(1);
  });

  it("rejects non-JSON", () => {
    const r = parseBundle("not json {");
    expect(r.ok).toBe(false);
  });

  it("rejects wrong kind", () => {
    const r = parseBundle(JSON.stringify({ ...JSON.parse(validBundle), kind: "other" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not a Helios workspace file/i);
  });

  it("rejects wrong version", () => {
    const r = parseBundle(JSON.stringify({ ...JSON.parse(validBundle), version: 99 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/version/i);
  });

  it("rejects missing workspaces array", () => {
    const r = parseBundle(JSON.stringify({ kind: BUNDLE_KIND, version: 1 }));
    expect(r.ok).toBe(false);
  });

  it("rejects empty workspaces array", () => {
    const r = parseBundle(JSON.stringify({ ...JSON.parse(validBundle), workspaces: [] }));
    expect(r.ok).toBe(false);
  });

  it("rejects workspace missing required fields", () => {
    const r = parseBundle(JSON.stringify({
      ...JSON.parse(validBundle),
      workspaces: [{ id: "a", label: "A" }],  // no color, no tiles
    }));
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement**

Add to `workspace-bundle.ts`:

```ts
export type ParseResult =
  | { ok: true; bundle: WorkspaceBundle }
  | { ok: false; reason: string };

export function parseBundle(json: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, reason: "Not valid JSON." };
  }
  if (!raw || typeof raw !== "object") {
    return { ok: false, reason: "Not a Helios workspace file." };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.kind !== BUNDLE_KIND) {
    return { ok: false, reason: "Not a Helios workspace file." };
  }
  if (obj.version !== BUNDLE_VERSION) {
    return { ok: false, reason: `Unsupported bundle version: ${String(obj.version)}.` };
  }
  if (!Array.isArray(obj.workspaces) || obj.workspaces.length === 0) {
    return { ok: false, reason: "Bundle contains no workspaces." };
  }
  for (const w of obj.workspaces) {
    if (
      !w || typeof w !== "object" ||
      typeof (w as Workspace).id !== "string" ||
      typeof (w as Workspace).label !== "string" ||
      typeof (w as Workspace).color !== "string" ||
      !Array.isArray((w as Workspace).tiles)
    ) {
      return { ok: false, reason: "Bundle contains a malformed workspace." };
    }
  }
  return { ok: true, bundle: obj as unknown as WorkspaceBundle };
}
```

- [ ] **Step 4: Run — green; commit**

```bash
git add apps/desktop/src/lib/workspace-bundle.ts apps/desktop/tests/workspace-bundle.test.ts
git commit -m "feat(workspaces): parseBundle with structural validation"
```

### Task 2.4: `mergeImported`

- [ ] **Step 1: Write tests**

Append to `workspace-bundle.test.ts`:

```ts
import { mergeImported } from "../src/lib/workspace-bundle";

describe("mergeImported", () => {
  const existing: Workspace[] = [
    { id: "x", label: "Overview", color: "#FFC627", tiles: [] },
  ];

  it("regenerates ids on every imported workspace", () => {
    const imported: Workspace[] = [
      { id: "x", label: "Other", color: "#aaa", tiles: [] },
    ];
    const out = mergeImported(existing, imported);
    expect(out.length).toBe(2);
    expect(out[1]!.id).not.toBe("x");
    expect(out[0]!.id).toBe("x");  // existing untouched
  });

  it("appends ' (imported)' on label collision", () => {
    const imported: Workspace[] = [
      { id: "y", label: "Overview", color: "#aaa", tiles: [] },
    ];
    const out = mergeImported(existing, imported);
    expect(out[1]!.label).toBe("Overview (imported)");
  });

  it("chains '(imported 2)', '(imported 3)' on repeated collisions", () => {
    const e: Workspace[] = [
      { id: "x", label: "Overview", color: "#fff", tiles: [] },
      { id: "y", label: "Overview (imported)", color: "#fff", tiles: [] },
    ];
    const out = mergeImported(e, [
      { id: "z", label: "Overview", color: "#aaa", tiles: [] },
    ]);
    expect(out[2]!.label).toBe("Overview (imported 2)");
  });

  it("dedupes labels among multiple imports in one batch", () => {
    const out = mergeImported(existing, [
      { id: "a", label: "Overview", color: "#1", tiles: [] },
      { id: "b", label: "Overview", color: "#2", tiles: [] },
    ]);
    expect(out[1]!.label).toBe("Overview (imported)");
    expect(out[2]!.label).toBe("Overview (imported 2)");
  });

  it("does not mutate inputs", () => {
    const e = [{ id: "x", label: "X", color: "#1", tiles: [] }];
    const i = [{ id: "y", label: "X", color: "#2", tiles: [] }];
    const eBefore = JSON.parse(JSON.stringify(e));
    const iBefore = JSON.parse(JSON.stringify(i));
    mergeImported(e, i);
    expect(e).toEqual(eBefore);
    expect(i).toEqual(iBefore);
  });
});
```

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement**

Add to `workspace-bundle.ts`:

```ts
/** Merge imported workspaces onto an existing list. Each imported workspace
 *  gets a fresh uuid (never preserve source ids — they could collide with
 *  built-ins or existing user state). Label collisions get suffixed with
 *  " (imported)", then "(imported 2)", etc., considering both the existing
 *  list AND any earlier-in-batch import that already grabbed the suffix. */
export function mergeImported(
  existing: Workspace[],
  imported: Workspace[],
): Workspace[] {
  const result = [...existing];
  for (const w of imported) {
    const newWorkspace: Workspace = {
      id: crypto.randomUUID(),
      label: dedupeLabel(w.label, result),
      color: w.color,
      tiles: JSON.parse(JSON.stringify(w.tiles)),
    };
    result.push(newWorkspace);
  }
  return result;
}

function dedupeLabel(label: string, existing: Workspace[]): string {
  const taken = new Set(existing.map((w) => w.label));
  if (!taken.has(label)) return label;
  let candidate = `${label} (imported)`;
  if (!taken.has(candidate)) return candidate;
  let n = 2;
  while (taken.has((candidate = `${label} (imported ${n})`))) n++;
  return candidate;
}
```

- [ ] **Step 4: Run — green; commit**

```bash
git add apps/desktop/src/lib/workspace-bundle.ts apps/desktop/tests/workspace-bundle.test.ts
git commit -m "feat(workspaces): mergeImported with id regen + label dedup"
```

---

## Phase 3 — `<ConfirmDialog>` component

This is the dependency for all the destructive actions. Build it before touching the tab bar so that wiring the bar can use a real component.

### Task 3.1: Write `<ConfirmDialog>` tests

**Files:**
- Create: `apps/desktop/tests/ConfirmDialog.test.tsx`

- [ ] **Step 1: Write tests**

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConfirmDialog } from "../src/components/ConfirmDialog";

describe("ConfirmDialog (confirm mode)", () => {
  function setup(overrides = {}) {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <ConfirmDialog
        title="Delete it?"
        body="This cannot be undone."
        confirmLabel="Delete"
        confirmTone="danger"
        cancelLabel="Cancel"
        onConfirm={onConfirm}
        onClose={onClose}
        {...overrides}
      />,
    );
    return { onConfirm, onClose };
  }

  it("renders title and body", () => {
    setup();
    expect(screen.getByText("Delete it?")).toBeInTheDocument();
    expect(screen.getByText("This cannot be undone.")).toBeInTheDocument();
  });

  it("clicking confirm fires onConfirm", () => {
    const { onConfirm } = setup();
    fireEvent.click(screen.getByRole("button", { name: /delete/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("clicking cancel fires onClose only", () => {
    const { onConfirm, onClose } = setup();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape fires onClose", () => {
    const { onConfirm, onClose } = setup();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("danger tone applies a red-styled confirm button", () => {
    setup();
    const btn = screen.getByRole("button", { name: /delete/i });
    expect(btn.className).toMatch(/EF5350|red|danger/i);
  });
});

describe("ConfirmDialog (alert mode — no cancelLabel)", () => {
  it("renders only the confirm button", () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <ConfirmDialog
        title="Could not import"
        body="Not a Helios workspace file."
        confirmLabel="OK"
        confirmTone="default"
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );
    expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^ok$/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run — fail (component missing)**

### Task 3.2: Implement `<ConfirmDialog>`

**Files:**
- Create: `apps/desktop/src/components/ConfirmDialog.tsx`

- [ ] **Step 1: Implement matching the existing modal style**

```tsx
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

export interface ConfirmDialogProps {
  title: string;
  body: string | ReactNode;
  confirmLabel: string;
  confirmTone: "default" | "danger";
  cancelLabel?: string;            // omit → alert mode (single button)
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog({
  title, body, confirmLabel, confirmTone, cancelLabel, onConfirm, onClose,
}: ConfirmDialogProps) {
  const isAlert = cancelLabel === undefined;
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function handleConfirm() {
    onConfirm();
    if (isAlert) onClose();  // alert dismisses itself on click
  }

  const confirmClass =
    "px-3 py-1 text-xs border rounded-sm cursor-pointer transition-colors " +
    (confirmTone === "danger"
      ? "bg-[#EF5350] text-[#0E0E10] border-[#EF5350] hover:bg-[#d83a37]"
      : "bg-[#FFC627] text-[#0E0E10] border-[#FFC627] hover:bg-[#e8b21f] font-semibold");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
    >
      <div
        className="bg-[#16171B] border border-[#2A2C32] rounded-sm shadow-xl min-w-[320px] max-w-[480px] p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="confirm-title" className="text-sm text-[#D8DCE2] font-semibold mb-2">{title}</h2>
        <div className="text-xs text-[#D8DCE2] mb-4">{body}</div>
        <div className="flex justify-end gap-2">
          {!isAlert && (
            <button
              onClick={onClose}
              className="px-3 py-1 text-xs border border-[#2A2C32] bg-[#16171B] text-[#D8DCE2] hover:border-[#7B8088] rounded-sm cursor-pointer transition-colors"
            >
              {cancelLabel}
            </button>
          )}
          <button ref={confirmRef} onClick={handleConfirm} className={confirmClass}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Run — green**

Run: `pnpm --filter @helios/desktop test`

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/components/ConfirmDialog.tsx apps/desktop/tests/ConfirmDialog.test.tsx
git commit -m "feat(desktop): ConfirmDialog component (confirm + alert modes)"
```

### Task 3.3: Migrate `handleResetWorkspaces` off `window.confirm`

**Files:**
- Modify: `apps/desktop/src/App.tsx`

Why this lives here, not in Phase 7: it validates `<ConfirmDialog>` works in the real app before we depend on it for the higher-stakes Delete-workspace flow, and it crosses the no-browser-dialogs goal off independently. We add a small `confirmState` slot for it now and reuse the same slot in Phase 7.

- [ ] **Step 1: Add `confirmState` to App.tsx**

Near the other `useState` calls in `App.tsx`, add:

```tsx
type ConfirmRequest = {
  title: string;
  body: string;
  confirmLabel: string;
  confirmTone: "default" | "danger";
  cancelLabel?: string;
  onConfirm: () => void;
};
const [confirmState, setConfirmState] = useState<ConfirmRequest | null>(null);
```

- [ ] **Step 2: Replace the body of `handleResetWorkspaces`**

```tsx
function handleResetWorkspaces() {
  setConfirmState({
    title: "Reset all workspaces?",
    body: "Every workspace will be replaced by its built-in default. Unsaved edits will be lost.",
    confirmLabel: "Reset all",
    confirmTone: "danger",
    cancelLabel: "Cancel",
    onConfirm: () => {
      const fresh = resetToBuiltins();
      setWorkspaces(fresh);
      setSelectedTileId(null);
      setConfirmState(null);
    },
  });
}
```

- [ ] **Step 3: Render the dialog slot in JSX**

Near the bottom of the returned JSX (next to the other modals), add:

```tsx
{confirmState && (
  <ConfirmDialog
    title={confirmState.title}
    body={confirmState.body}
    confirmLabel={confirmState.confirmLabel}
    confirmTone={confirmState.confirmTone}
    cancelLabel={confirmState.cancelLabel}
    onConfirm={confirmState.onConfirm}
    onClose={() => setConfirmState(null)}
  />
)}
```

Don't forget the import: `import { ConfirmDialog } from "./components/ConfirmDialog";`

- [ ] **Step 4: Verify manually**

Run the dev app: `pnpm --filter @helios/desktop dev` (or `tauri dev` from the desktop dir).

Click `Edit` → `Reset all`. Custom dialog appears. Cancel works. Reset confirms and reseeds.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/App.tsx
git commit -m "refactor(desktop): replace window.confirm in resetWorkspaces with ConfirmDialog"
```

---

## Phase 4 — Tauri dialog + filesystem wrappers

The dialog plugin returns paths but does not read/write file contents. To save/load bundles we also need `tauri-plugin-fs`. This phase wires both plugins (one not installed yet — verified against the current `apps/desktop/package.json` and `Cargo.toml`) and adds a small TS wrapper module.

### Task 4.1: Add `tauri-plugin-fs` (JS + Rust + capability)

**Files:**
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/capabilities/default.json`

- [ ] **Step 1: Add the JS dep**

```bash
pnpm --filter @helios/desktop add @tauri-apps/plugin-fs@^2.0.0
```

- [ ] **Step 2: Add the Rust crate**

In `apps/desktop/src-tauri/Cargo.toml` under `[dependencies]`, append:

```toml
tauri-plugin-fs = "2"
```

- [ ] **Step 3: Register the plugin in `lib.rs`**

Add `.plugin(tauri_plugin_fs::init())` to the builder chain (next to the `tauri_plugin_dialog::init()` registered in Task 0.2).

- [ ] **Step 4: Grant the fs capabilities**

In `apps/desktop/src-tauri/capabilities/default.json`, append the following permission strings to the `permissions` array (after `"dialog:default"`):

```json
"fs:default",
"fs:allow-read-text-file",
"fs:allow-write-text-file"
```

`fs:scope` is intentionally not added — we operate only on absolute paths that come back from the native dialog (the user picked them, so they're implicitly authorized for that one operation). If a future need arises for unscoped reads/writes, that will be a separate, deliberate change.

- [ ] **Step 5: Verify Rust compiles**

Run: `pnpm --filter @helios/desktop build` (or `cargo check` in `src-tauri`)
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/package.json pnpm-lock.yaml apps/desktop/src-tauri/Cargo.toml Cargo.lock apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/capabilities/default.json
git commit -m "chore(desktop): register tauri-plugin-fs + grant text-file capabilities"
```

### Task 4.2: Save / open helpers

**Files:**
- Create: `apps/desktop/src/lib/workspace-dialog.ts`

- [ ] **Step 1: Implement**

```ts
import { save, open } from "@tauri-apps/plugin-dialog";
import { writeTextFile, readTextFile } from "@tauri-apps/plugin-fs";

const JSON_FILTER = [{ name: "JSON files", extensions: ["json"] }];

/** Open a native save dialog and write `contents` to the chosen file.
 *  Returns the chosen path, or null if the user cancelled. */
export async function saveJsonFile(
  defaultFileName: string,
  contents: string,
): Promise<string | null> {
  const path = await save({
    defaultPath: defaultFileName,
    filters: JSON_FILTER,
  });
  if (!path) return null;
  await writeTextFile(path, contents);
  return path;
}

/** Open a native open dialog filtered to JSON, read the chosen file, return
 *  its contents. Returns null if the user cancelled. */
export async function openJsonFile(): Promise<string | null> {
  const result = await open({
    multiple: false,
    filters: JSON_FILTER,
  });
  if (!result) return null;
  const path = typeof result === "string" ? result : (result as { path: string }).path;
  return await readTextFile(path);
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @helios/desktop typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/lib/workspace-dialog.ts
git commit -m "feat(desktop): native save/open dialog helpers for workspace bundles"
```

> **NOTE on testing:** `workspace-dialog.ts` is intentionally not unit-tested directly — it's a thin pass-through to Tauri APIs that are unavailable in jsdom. Its behavior is verified during the Phase 7 manual smoke test.

---

## Phase 5 — `<TabContextMenu>` component

### Task 5.1: Write tests

**Files:**
- Create: `apps/desktop/tests/TabContextMenu.test.tsx`

- [ ] **Step 1: Write tests**

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TabContextMenu } from "../src/components/TabContextMenu";

const PALETTE = ["#FFC627", "#4FC3F7", "#66BB6A", "#EF5350"];

function defaultProps(overrides = {}) {
  return {
    anchor: { x: 100, y: 100 },
    canDelete: true,
    palette: PALETTE,
    onRename: vi.fn(),
    onRecolor: vi.fn(),
    onDuplicate: vi.fn(),
    onExport: vi.fn(),
    onDelete: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

describe("TabContextMenu", () => {
  it("renders all five primary entries", () => {
    render(<TabContextMenu {...defaultProps()} />);
    expect(screen.getByRole("menuitem", { name: /rename/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /color/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /duplicate/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /export/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /delete/i })).toBeInTheDocument();
  });

  it("disables Delete when canDelete=false", () => {
    render(<TabContextMenu {...defaultProps({ canDelete: false })} />);
    const del = screen.getByRole("menuitem", { name: /delete/i });
    expect(del).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(del);
    // shouldn't fire — but onDelete is in defaultProps; create fresh local mock to assert
  });

  it("clicking Rename calls onRename + onClose", () => {
    const props = defaultProps();
    render(<TabContextMenu {...props} />);
    fireEvent.click(screen.getByRole("menuitem", { name: /rename/i }));
    expect(props.onRename).toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalled();
  });

  it("Color submenu shows palette swatches and calls onRecolor with the chosen hex", () => {
    const props = defaultProps();
    render(<TabContextMenu {...props} />);
    fireEvent.mouseEnter(screen.getByRole("menuitem", { name: /color/i }));
    const swatches = screen.getAllByRole("menuitem", { name: /color #/i });
    expect(swatches.length).toBe(PALETTE.length);
    fireEvent.click(swatches[1]!);
    expect(props.onRecolor).toHaveBeenCalledWith(PALETTE[1]);
  });

  it("Escape closes the menu", () => {
    const props = defaultProps();
    render(<TabContextMenu {...props} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — fail (component missing)**

### Task 5.2: Implement `<TabContextMenu>`

**Files:**
- Create: `apps/desktop/src/components/TabContextMenu.tsx`

- [ ] **Step 1: Implement**

```tsx
import { useEffect, useRef, useState } from "react";

export interface TabContextMenuProps {
  anchor: { x: number; y: number };
  canDelete: boolean;          // false when only one workspace remains
  palette: readonly string[];  // 8 hex strings
  onRename: () => void;
  onRecolor: (hex: string) => void;
  onDuplicate: () => void;
  onExport: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export function TabContextMenu(props: TabContextMenuProps) {
  const { anchor, canDelete, palette, onClose } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [colorOpen, setColorOpen] = useState(false);
  const [colorFlipLeft, setColorFlipLeft] = useState(false);

  // Close on Escape, outside-click, or window resize.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    }
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  // Position with viewport-overflow handling (flip up/left if too close to edge).
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: anchor.x, top: anchor.y });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = anchor.x;
    let top = anchor.y;
    if (left + r.width > window.innerWidth - 4) left = Math.max(4, anchor.x - r.width);
    if (top + r.height > window.innerHeight - 4) top = Math.max(4, anchor.y - r.height);
    setPos({ left, top });
  }, [anchor]);

  // Detect if the color submenu would overflow right; flip it left if so.
  function onColorEnter() {
    setColorOpen(true);
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setColorFlipLeft(r.right + 160 > window.innerWidth);
  }

  function fire(handler: () => void) {
    handler();
    onClose();
  }

  const itemBase =
    "px-3 py-1 text-xs cursor-pointer text-[#D8DCE2] hover:bg-[#23252b] hover:text-[#FFC627] flex items-center justify-between";
  const itemDisabled =
    "px-3 py-1 text-xs text-[#5A5F66] flex items-center justify-between cursor-not-allowed";

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Workspace actions"
      style={{ position: "fixed", left: pos.left, top: pos.top, zIndex: 60, minWidth: 160 }}
      className="bg-[#16171B] border border-[#2A2C32] rounded-sm shadow-xl py-1"
      onClick={(e) => e.stopPropagation()}
    >
      <div role="menuitem" className={itemBase} onClick={() => fire(props.onRename)}>
        Rename
      </div>
      <div
        role="menuitem"
        className={itemBase}
        onMouseEnter={onColorEnter}
        onMouseLeave={() => setColorOpen(false)}
      >
        <span>Color</span>
        <span className="text-[#7B8088]">▸</span>
        {colorOpen && (
          <div
            role="menu"
            aria-label="Color"
            className="absolute bg-[#16171B] border border-[#2A2C32] rounded-sm shadow-xl py-1"
            style={{
              top: 0,
              [colorFlipLeft ? "right" : "left"]: "100%" as const,
              minWidth: 140,
            }}
          >
            {palette.map((hex) => (
              <div
                key={hex}
                role="menuitem"
                aria-label={`Color ${hex}`}
                className={itemBase}
                onClick={() => fire(() => props.onRecolor(hex))}
              >
                <span
                  className="inline-block w-3 h-3 rounded-sm mr-2 border border-black/20"
                  style={{ background: hex }}
                />
                <span className="font-mono-num">{hex}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div role="menuitem" className={itemBase} onClick={() => fire(props.onDuplicate)}>
        Duplicate
      </div>
      <div role="menuitem" className={itemBase} onClick={() => fire(props.onExport)}>
        Export…
      </div>
      <div className="my-1 border-t border-[#2A2C32]" />
      {canDelete ? (
        <div
          role="menuitem"
          className={itemBase + " hover:!text-[#EF5350]"}
          onClick={() => fire(props.onDelete)}
        >
          Delete
        </div>
      ) : (
        <div role="menuitem" aria-disabled="true" className={itemDisabled}>
          Delete
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Run tests — green**

Run: `pnpm --filter @helios/desktop test`

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/components/TabContextMenu.tsx apps/desktop/tests/TabContextMenu.test.tsx
git commit -m "feat(desktop): TabContextMenu with color submenu + viewport overflow"
```

---

## Phase 6 — `<WorkspaceTabBar>` component

This is the biggest component. Build it in three slices: render, rename, drag/menu wiring.

### Task 6.1: Static rendering — tabs + buttons

**Files:**
- Create: `apps/desktop/src/components/WorkspaceTabBar.tsx`
- Create: `apps/desktop/tests/WorkspaceTabBar.test.tsx`

- [ ] **Step 1: Write rendering tests**

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WorkspaceTabBar } from "../src/components/WorkspaceTabBar";
import type { Workspace } from "../src/workspaces/types";

const ws: Workspace[] = [
  { id: "a", label: "Overview",     color: "#FFC627", tiles: [] },
  { id: "b", label: "Engine focus", color: "#EF5350", tiles: [] },
];

function defaultProps(overrides = {}) {
  return {
    workspaces: ws,
    activeId: "a",
    appVersion: "2.3.2",
    onSelect: vi.fn(),
    onCreate: vi.fn(),
    onRename: vi.fn(),
    onRecolor: vi.fn(),
    onDuplicate: vi.fn(),
    onDelete: vi.fn(),
    onReorder: vi.fn(),
    onExport: vi.fn(),
    onExportAll: vi.fn(),
    onImport: vi.fn(),
    ...overrides,
  };
}

describe("WorkspaceTabBar — rendering", () => {
  it("renders one tab per workspace with its label and color swatch", () => {
    render(<WorkspaceTabBar {...defaultProps()} />);
    expect(screen.getByRole("tab", { name: /overview/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /engine focus/i })).toBeInTheDocument();
    // Swatches are aria-hidden, so query by data attribute.
    expect(screen.getAllByTestId("workspace-swatch").length).toBe(2);
  });

  it("clicking a tab fires onSelect", () => {
    const props = defaultProps();
    render(<WorkspaceTabBar {...props} />);
    fireEvent.click(screen.getByRole("tab", { name: /engine focus/i }));
    expect(props.onSelect).toHaveBeenCalledWith("b");
  });

  it("+ New workspace button fires onCreate", () => {
    const props = defaultProps();
    render(<WorkspaceTabBar {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /new workspace/i }));
    expect(props.onCreate).toHaveBeenCalled();
  });

  it("Import button fires onImport", () => {
    const props = defaultProps();
    render(<WorkspaceTabBar {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /^import/i }));
    expect(props.onImport).toHaveBeenCalled();
  });

  it("Export all button fires onExportAll", () => {
    const props = defaultProps();
    render(<WorkspaceTabBar {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /export all/i }));
    expect(props.onExportAll).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement minimal version**

```tsx
import { useState } from "react";
import type { Workspace } from "../workspaces/types";
import { SESSION_PALETTE } from "../lib/session";

export interface WorkspaceTabBarProps {
  workspaces: Workspace[];
  activeId: string;
  appVersion: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, label: string) => void;
  onRecolor: (id: string, hex: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onExport: (id: string) => void;
  onExportAll: () => void;
  onImport: () => void;
}

export function WorkspaceTabBar(props: WorkspaceTabBarProps) {
  const { workspaces, activeId, onSelect, onCreate, onImport, onExportAll } = props;

  return (
    <div className="ml-2 flex gap-1 items-center">
      <div role="tablist" className="flex gap-1">
        {workspaces.map((w) => {
          const active = w.id === activeId;
          return (
            <button
              key={w.id}
              role="tab"
              aria-selected={active}
              onClick={() => onSelect(w.id)}
              className={
                "flex items-center gap-1.5 px-2 py-0.5 text-xs border rounded-sm cursor-pointer transition-colors " +
                (active
                  ? "bg-[#FFC627] text-[#0E0E10] border-[#FFC627] font-semibold"
                  : "bg-[#16171B] text-[#D8DCE2] border-[#2A2C32] hover:border-[#FFC627]")
              }
            >
              <span
                data-testid="workspace-swatch"
                aria-hidden
                className="inline-block w-2 h-2 rounded-sm"
                style={{ background: w.color }}
              />
              <span>{w.label}</span>
            </button>
          );
        })}
      </div>
      <button
        onClick={onCreate}
        className="ml-1 px-2 py-0.5 text-xs border border-[#2A2C32] bg-[#16171B] text-[#FFC627] hover:border-[#FFC627] rounded-sm cursor-pointer transition-colors"
        title="Create a new empty workspace"
      >
        + New workspace
      </button>
      <button
        onClick={onImport}
        className="px-2 py-0.5 text-xs border border-[#2A2C32] bg-[#16171B] text-[#D8DCE2] hover:border-[#FFC627] rounded-sm cursor-pointer transition-colors"
        title="Import workspaces from a Helios bundle"
      >
        Import…
      </button>
      <button
        onClick={onExportAll}
        className="px-2 py-0.5 text-xs border border-[#2A2C32] bg-[#16171B] text-[#D8DCE2] hover:border-[#FFC627] rounded-sm cursor-pointer transition-colors"
        title="Export every workspace to a single file"
      >
        Export all…
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run — green; commit**

```bash
git add apps/desktop/src/components/WorkspaceTabBar.tsx apps/desktop/tests/WorkspaceTabBar.test.tsx
git commit -m "feat(desktop): WorkspaceTabBar — initial rendering of tabs + buttons"
```

### Task 6.2: Inline rename

- [ ] **Step 1: Append tests**

```tsx
describe("WorkspaceTabBar — inline rename", () => {
  it("double-click on the label puts the tab in rename mode", () => {
    const props = defaultProps();
    render(<WorkspaceTabBar {...props} />);
    fireEvent.doubleClick(screen.getByText("Overview"));
    expect(screen.getByDisplayValue("Overview")).toBeInTheDocument();
  });

  it("Enter commits the new label", () => {
    const props = defaultProps();
    render(<WorkspaceTabBar {...props} />);
    fireEvent.doubleClick(screen.getByText("Overview"));
    const input = screen.getByDisplayValue("Overview") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Track A" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onRename).toHaveBeenCalledWith("a", "Track A");
  });

  it("Escape cancels", () => {
    const props = defaultProps();
    render(<WorkspaceTabBar {...props} />);
    fireEvent.doubleClick(screen.getByText("Overview"));
    const input = screen.getByDisplayValue("Overview") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Track A" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(props.onRename).not.toHaveBeenCalled();
  });

  it("empty / whitespace-only commit is treated as cancel", () => {
    const props = defaultProps();
    render(<WorkspaceTabBar {...props} />);
    fireEvent.doubleClick(screen.getByText("Overview"));
    const input = screen.getByDisplayValue("Overview") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onRename).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Add rename to component**

In `WorkspaceTabBar.tsx`, add inline rename:

```tsx
const [renamingId, setRenamingId] = useState<string | null>(null);
const [renameValue, setRenameValue] = useState("");

function startRename(w: Workspace) {
  setRenamingId(w.id);
  setRenameValue(w.label);
}
function commitRename() {
  if (renamingId === null) return;
  const trimmed = renameValue.trim();
  if (trimmed.length > 0 && trimmed !== workspaces.find((w) => w.id === renamingId)?.label) {
    props.onRename(renamingId, trimmed);
  }
  setRenamingId(null);
}
function cancelRename() {
  setRenamingId(null);
}
```

Replace the `<span>{w.label}</span>` inside each tab with:

```tsx
{renamingId === w.id ? (
  <input
    autoFocus
    value={renameValue}
    onChange={(e) => setRenameValue(e.target.value)}
    onKeyDown={(e) => {
      if (e.key === "Enter") { e.preventDefault(); commitRename(); }
      else if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
    }}
    onBlur={commitRename}
    onClick={(e) => e.stopPropagation()}
    onDoubleClick={(e) => e.stopPropagation()}
    className="bg-transparent border-b border-current px-0.5 outline-none w-24"
  />
) : (
  <span onDoubleClick={(e) => { e.stopPropagation(); startRename(w); }}>{w.label}</span>
)}
```

- [ ] **Step 4: Run — green; commit**

```bash
git add apps/desktop/src/components/WorkspaceTabBar.tsx apps/desktop/tests/WorkspaceTabBar.test.tsx
git commit -m "feat(desktop): WorkspaceTabBar inline rename"
```

### Task 6.3: Drag-reorder

> **NOTE:** jsdom does not fully simulate HTML5 drag events. We can unit-test the reducer logic by exposing `computeDropIndex` as a pure helper, but actual drag flow is verified manually in Phase 7. Keep the test surface narrow.

- [ ] **Step 1: Add a unit test for `computeDropIndex` helper**

In `WorkspaceTabBar.test.tsx`:

```tsx
import { computeDropIndex } from "../src/components/WorkspaceTabBar";

describe("computeDropIndex", () => {
  // Tabs at: [0..50] [50..100] [100..150]
  const rects: Array<Pick<DOMRect, "left" | "right">> = [
    { left: 0, right: 50 },
    { left: 50, right: 100 },
    { left: 100, right: 150 },
  ];

  it("snaps to the gap before the tab whose midpoint mouseX is left of", () => {
    expect(computeDropIndex(rects, 24)).toBe(0);   // left half of tab 0
    expect(computeDropIndex(rects, 26)).toBe(1);   // right half of tab 0
    expect(computeDropIndex(rects, 76)).toBe(2);   // right half of tab 1
  });

  it("snaps past the last tab when mouseX is past the rightmost midpoint", () => {
    expect(computeDropIndex(rects, 200)).toBe(3);
  });

  it("clamps negative inputs to 0", () => {
    expect(computeDropIndex(rects, -10)).toBe(0);
  });
});
```

- [ ] **Step 2: Implement the helper + drag handlers**

In `WorkspaceTabBar.tsx`:

```tsx
/** Where to insert a dragged tab given the current mouse-X and the on-screen
 *  rects of every tab. Returns a "gap index" in [0..rects.length]: 0 means
 *  before the first tab, rects.length means after the last. The drop handler
 *  in App.tsx subtracts 1 when moving rightward (because the source is removed
 *  before the insertion happens), so the value here is the **pre-removal**
 *  gap index — see Task 6.3 Step 3 below for the +/-1 convention. */
export function computeDropIndex(
  rects: Array<Pick<DOMRect, "left" | "right">>,
  mouseX: number,
): number {
  if (mouseX < (rects[0]?.left ?? 0)) return 0;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i]!;
    const mid = (r.left + r.right) / 2;
    if (mouseX < mid) return i;
  }
  return rects.length;
}
```

Add a `tabRefs` ref-array and drag state:

```tsx
const tabRefs = useRef<Array<HTMLElement | null>>([]);
const [dragSourceIndex, setDragSourceIndex] = useState<number | null>(null);
const [dropIndex, setDropIndex] = useState<number | null>(null);
```

On each tab, wire `draggable` (only when not renaming):

```tsx
<button
  ...
  ref={(el) => { tabRefs.current[i] = el; }}
  draggable={renamingId !== w.id}
  onDragStart={(e) => {
    setDragSourceIndex(i);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", w.id);
  }}
  onDragOver={(e) => {
    if (dragSourceIndex === null) return;
    e.preventDefault();
    const rects = tabRefs.current.map((el) => el?.getBoundingClientRect()).filter(Boolean) as DOMRect[];
    setDropIndex(computeDropIndex(rects.map((r) => ({ left: r.left, right: r.right })), e.clientX));
  }}
  onDrop={(e) => {
    e.preventDefault();
    if (dragSourceIndex !== null && dropIndex !== null && dropIndex !== dragSourceIndex && dropIndex !== dragSourceIndex + 1) {
      // dropIndex is the pre-removal gap index. App.tsx's onReorder splices
      // out the source first, then inserts at the target — so when we drop
      // RIGHTward of the source, we subtract one to account for the shift.
      const target = dropIndex > dragSourceIndex ? dropIndex - 1 : dropIndex;
      props.onReorder(dragSourceIndex, target);
    }
    setDragSourceIndex(null);
    setDropIndex(null);
  }}
  onDragEnd={() => { setDragSourceIndex(null); setDropIndex(null); }}
>
  ...
</button>
```

Render a thin yellow vertical bar between tabs at `dropIndex` while dragging — leave styling lightweight, e.g. a 2px wide span absolutely positioned by the parent's flexbox. Implementation tip: render an inline-flex divider at each gap that is invisible until `dropIndex` hits that gap.

- [ ] **Step 3: Run — `computeDropIndex` test green**

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/components/WorkspaceTabBar.tsx apps/desktop/tests/WorkspaceTabBar.test.tsx
git commit -m "feat(desktop): WorkspaceTabBar drag-reorder + computeDropIndex"
```

### Task 6.4: Right-click → context menu

- [ ] **Step 1: Add tests**

```tsx
describe("WorkspaceTabBar — context menu", () => {
  it("right-click on a tab opens the TabContextMenu", () => {
    const props = defaultProps();
    render(<WorkspaceTabBar {...props} />);
    fireEvent.contextMenu(screen.getByRole("tab", { name: /overview/i }));
    expect(screen.getByRole("menu", { name: /workspace actions/i })).toBeInTheDocument();
  });

  it("Delete entry is disabled when only one workspace remains", () => {
    const props = defaultProps({ workspaces: [ws[0]], activeId: "a" });
    render(<WorkspaceTabBar {...props} />);
    fireEvent.contextMenu(screen.getByRole("tab", { name: /overview/i }));
    const del = screen.getByRole("menuitem", { name: /^delete$/i });
    expect(del).toHaveAttribute("aria-disabled", "true");
  });

  it("clicking Duplicate fires onDuplicate with the right id", () => {
    const props = defaultProps();
    render(<WorkspaceTabBar {...props} />);
    fireEvent.contextMenu(screen.getByRole("tab", { name: /engine focus/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /duplicate/i }));
    expect(props.onDuplicate).toHaveBeenCalledWith("b");
  });

  it("clicking Export fires onExport with the right id", () => {
    const props = defaultProps();
    render(<WorkspaceTabBar {...props} />);
    fireEvent.contextMenu(screen.getByRole("tab", { name: /overview/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /export/i }));
    expect(props.onExport).toHaveBeenCalledWith("a");
  });
});
```

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Wire it in `WorkspaceTabBar`**

```tsx
const [menuFor, setMenuFor] = useState<{ workspaceId: string; x: number; y: number } | null>(null);

// On each tab:
onContextMenu={(e) => {
  e.preventDefault();
  setMenuFor({ workspaceId: w.id, x: e.clientX, y: e.clientY });
}}
```

After the tab list, render:

```tsx
{menuFor && (() => {
  const target = workspaces.find((w) => w.id === menuFor.workspaceId);
  if (!target) return null;
  return (
    <TabContextMenu
      anchor={{ x: menuFor.x, y: menuFor.y }}
      canDelete={workspaces.length > 1}
      palette={SESSION_PALETTE}
      onRename={() => startRename(target)}
      onRecolor={(hex) => props.onRecolor(target.id, hex)}
      onDuplicate={() => props.onDuplicate(target.id)}
      onExport={() => props.onExport(target.id)}
      onDelete={() => props.onDelete(target.id)}
      onClose={() => setMenuFor(null)}
    />
  );
})()}
```

Don't forget the import: `import { TabContextMenu } from "./TabContextMenu";`

- [ ] **Step 4: Run — green; commit**

```bash
git add apps/desktop/src/components/WorkspaceTabBar.tsx apps/desktop/tests/WorkspaceTabBar.test.tsx
git commit -m "feat(desktop): WorkspaceTabBar right-click context menu wiring"
```

---

## Phase 7 — App.tsx integration

This task replaces the inline tab map with `<WorkspaceTabBar>` and adds the workspace-level callbacks that thread through the existing `commitWorkspaces` helper.

### Task 7.1: Add the workspace mutation callbacks

**Files:**
- Modify: `apps/desktop/src/App.tsx`

- [ ] **Step 1: Replace the inline tab map with `<WorkspaceTabBar>`**

In `App.tsx`, in the header JSX, swap the existing `<div className="ml-2 flex gap-1">…</div>` block (and the now-redundant `+ Add tile` button stays where it is, as it's tile-level) for:

```tsx
<WorkspaceTabBar
  workspaces={workspaces}
  activeId={workspaceId}
  appVersion={APP_VERSION}
  onSelect={(id) => { setWorkspaceId(id); setSelectedTileId(null); }}
  onCreate={handleCreateWorkspace}
  onRename={handleRenameWorkspace}
  onRecolor={handleRecolorWorkspace}
  onDuplicate={handleDuplicateWorkspace}
  onDelete={handleRequestDeleteWorkspace}
  onReorder={handleReorderWorkspaces}
  onExport={handleExportWorkspace}
  onExportAll={handleExportAllWorkspaces}
  onImport={handleImportWorkspaces}
/>
```

- [ ] **Step 2: Source `APP_VERSION`**

At top of `App.tsx`, near other imports:

```ts
import { getVersion } from "@tauri-apps/api/app";
```

Add a tiny effect-driven state so the bar always has a current version:

```tsx
const [appVersion, setAppVersion] = useState<string>("dev");
useEffect(() => { getVersion().then(setAppVersion).catch(() => {}); }, []);
```

Pass `appVersion` into `<WorkspaceTabBar>` instead of a hardcoded constant.

- [ ] **Step 3: Add the workspace callbacks**

After `commitWorkspaces`:

```tsx
function handleCreateWorkspace() {
  const usedColors = new Set(workspaces.map((w) => w.color));
  const nextColor = SESSION_PALETTE.find((c) => !usedColors.has(c)) ?? SESSION_PALETTE[workspaces.length % SESSION_PALETTE.length]!;
  // Pick the lowest-numbered "Workspace N" that isn't taken.
  const taken = new Set(workspaces.map((w) => w.label));
  let n = 1;
  while (taken.has(`Workspace ${n}`)) n++;
  const fresh: Workspace = {
    id: crypto.randomUUID(),
    label: `Workspace ${n}`,
    color: nextColor,
    tiles: [],
  };
  commitWorkspaces((prev) => [...prev, fresh]);
  setWorkspaceId(fresh.id);
  setSelectedTileId(null);
}

function handleRenameWorkspace(id: string, label: string) {
  commitWorkspaces((prev) => prev.map((w) => (w.id === id ? { ...w, label } : w)));
}

function handleRecolorWorkspace(id: string, color: string) {
  commitWorkspaces((prev) => prev.map((w) => (w.id === id ? { ...w, color } : w)));
}

function handleDuplicateWorkspace(id: string) {
  const src = workspaces.find((w) => w.id === id);
  if (!src) return;
  const copy: Workspace = {
    ...JSON.parse(JSON.stringify(src)),
    id: crypto.randomUUID(),
    label: `${src.label} copy`,
  };
  commitWorkspaces((prev) => {
    const i = prev.findIndex((w) => w.id === id);
    const next = [...prev];
    next.splice(i + 1, 0, copy);
    return next;
  });
  setWorkspaceId(copy.id);
  setSelectedTileId(null);
}

function handleRequestDeleteWorkspace(id: string) {
  if (workspaces.length <= 1) return;       // defensive — UI also disables
  const target = workspaces.find((w) => w.id === id);
  if (!target) return;
  setConfirmState({
    title: `Delete workspace "${target.label}"?`,
    body: "This cannot be undone. Tiles in this workspace will be lost.",
    confirmLabel: "Delete",
    confirmTone: "danger",
    cancelLabel: "Cancel",
    onConfirm: () => {
      commitWorkspaces((prev) => prev.filter((w) => w.id !== id));
      // If we deleted the active workspace, switch to a neighbor.
      if (workspaceId === id) {
        const remaining = workspaces.filter((w) => w.id !== id);
        const idx = workspaces.findIndex((w) => w.id === id);
        const next = remaining[idx] ?? remaining[idx - 1] ?? remaining[0]!;
        setWorkspaceId(next.id);
        setSelectedTileId(null);
      }
      setConfirmState(null);
    },
  });
}

function handleReorderWorkspaces(fromIndex: number, toIndex: number) {
  commitWorkspaces((prev) => {
    const next = [...prev];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved!);
    return next;
  });
}

async function handleExportWorkspace(id: string) {
  const w = workspaces.find((x) => x.id === id);
  if (!w) return;
  const json = serializeBundle([w], appVersion);
  await saveJsonFile(`helios-workspace-${slugifyForFilename(w.label)}.json`, json);
}

async function handleExportAllWorkspaces() {
  const json = serializeBundle(workspaces, appVersion);
  await saveJsonFile("helios-workspaces.json", json);
}

async function handleImportWorkspaces() {
  const text = await openJsonFile();
  if (text === null) return;
  const result = parseBundle(text);
  if (!result.ok) {
    setConfirmState({
      title: "Could not import",
      body: result.reason,
      confirmLabel: "OK",
      confirmTone: "default",
      onConfirm: () => setConfirmState(null),
    });
    return;
  }
  // We snapshot the current `workspaces` length BEFORE calling
  // commitWorkspaces, then look up the freshly-imported workspace by index in
  // the merged array. This is correct here because mergeImported preserves
  // the existing list's order at the front. Do NOT "fix" this to read from
  // the post-update state — at this call site the closure's `workspaces` is
  // the right reference for computing the index. The functional setState
  // pattern still applies (commitWorkspaces takes a (prev) => next updater).
  const firstImportedIndex = workspaces.length;
  const merged = mergeImported(workspaces, result.bundle.workspaces);
  commitWorkspaces(() => merged);
  setWorkspaceId(merged[firstImportedIndex]!.id);
  setSelectedTileId(null);
}
```

- [ ] **Step 4: Imports**

Add to top of `App.tsx`:

```ts
import { WorkspaceTabBar } from "./components/WorkspaceTabBar";
import { SESSION_PALETTE } from "./lib/session";
import { serializeBundle, parseBundle, mergeImported, slugifyForFilename } from "./lib/workspace-bundle";
import { saveJsonFile, openJsonFile } from "./lib/workspace-dialog";
```

- [ ] **Step 5: Typecheck + tests**

Run:
```bash
pnpm --filter @helios/desktop typecheck
pnpm --filter @helios/desktop test
```
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/App.tsx
git commit -m "feat(desktop): wire workspace CRUD callbacks + WorkspaceTabBar in App"
```

### Task 7.2: Manual smoke test

Run: `pnpm --filter @helios/desktop dev`

Walk through the 12-step plan from the spec ("Testing → Manual smoke test plan"):

- [ ] 1. Fresh launch — built-ins show with their colors (yellow Overview, red Engine focus).
- [ ] 2. `+ New workspace` → "Workspace 1" appears, switched-to, empty.
- [ ] 3. Double-click new tab → rename to "Test", Enter → reload → label persists.
- [ ] 4. Right-click "Test" → Color → green → swatch turns green; reload → still green. Hover-test: moving the mouse from the parent "Color" row INTO the submenu must not cause the submenu to flicker closed (small gap between parent row and submenu can cause `mouseleave` → close → reopen). If that happens, widen the parent row's hit-area so there's no dead pixel between it and the submenu.
- [ ] 5. Drag "Test" between Overview and Engine focus → reload → order persists.
- [ ] 6. Right-click "Test" → Duplicate → "Test copy" appears next to it.
- [ ] 7. Right-click "Test copy" → Export… → save to disk; open the JSON in a text editor → verify `kind: "helios-workspace-bundle"`, `version: 1`, single workspace.
- [ ] 8. Right-click "Test copy" → Delete → custom dialog confirms; on confirm, gone.
- [ ] 9. `Import…` → load step-7 file → "Test" reappears (no id collision); reload → still there.
- [ ] 10. `Export all…` → bundle contains every current workspace.
- [ ] 11. Try to delete the last remaining workspace → Delete menu entry is greyed out.
- [ ] 12. `Reset all` → uses the new `<ConfirmDialog>` (not browser); on confirm, reseeds built-ins with their colors.

If any step fails, file the bug, fix it, re-run from start.

---

## Phase 8 — Polish, docs, version bump

### Task 8.1: Add `v2_changes/25-workspace-management.md`

**Files:**
- Create: `v2_changes/25-workspace-management.md`
- Modify: `v2_changes/README.md`

- [ ] **Step 1: Create the change-log entry**

Match the style of the other v2_changes entries (look at e.g. `v2_changes/24-track-labels.md` for tone and structure). Cover: what was hardcoded before, what's user-managed now, the new bundle format, and the dialog migration.

- [ ] **Step 2: Add the line to the README index**

In `v2_changes/README.md`, append:

```
- [25 — Workspace management](25-workspace-management.md) — create/rename/color/reorder/duplicate/delete workspaces; export/import bundles; custom confirm dialog replaces window.confirm()
```

- [ ] **Step 3: Commit**

```bash
git add v2_changes/25-workspace-management.md v2_changes/README.md
git commit -m "docs: v2_changes — workspace management entry"
```

### Task 8.2: Bump app version to 2.3.2 (DO NOT TAG)

This sets the version that ships with the next release pipeline run. We deliberately do NOT create a `v2.3.2` git tag here — the tag is the trigger for the `release.yml` GitHub Actions workflow, and the user has explicitly asked us not to release as part of this work.

**Files:**
- Modify: `package.json`
- Modify: `Cargo.toml`
- Modify: `apps/desktop/src-tauri/tauri.conf.json`
- Modify: `apps/desktop/package.json`

- [ ] **Step 1: Run the bump script**

Run: `node scripts/bump-version.mjs 2.3.2`

Expected: it updates the four version fields in lockstep (root `package.json`, root `Cargo.toml`, `apps/desktop/package.json`, `apps/desktop/src-tauri/tauri.conf.json`). This is the standard tooling per the launcher work ([scripts/bump-version.mjs](../../scripts/bump-version.mjs)).

- [ ] **Step 2: Verify**

Run: `node scripts/check-versions.mjs`
Expected: all four files report `2.3.2`.

- [ ] **Step 3: Commit (DO NOT TAG)**

```bash
git add package.json Cargo.toml apps/desktop/package.json apps/desktop/src-tauri/tauri.conf.json
git commit -m "chore: bump to 2.3.2 (workspace management; do not release yet)"
```

> **CRITICAL:** Do NOT run `git tag v2.3.2` and do NOT push tags. The tag triggers the release pipeline. The user wants this version bumped now, released later (as a separate, explicit step).

---

## Definition of Done

- All Phase 0–8 tasks complete with green tests.
- `pnpm --filter @helios/desktop typecheck` clean.
- `pnpm --filter @helios/desktop test` clean.
- Manual smoke test (Task 7.2) walks through all 12 steps without bugs.
- No occurrence of `window.confirm`, `window.alert`, or `window.prompt` remains in `apps/desktop/src/` (verify with `Grep` — should match zero files).
- v2_changes entry committed.
- Version bumped to 2.3.2; no tag created.

---

## Notes for the executor

- **Stale-closure trap:** every workspace mutator must funnel through `commitWorkspaces((prev) => …)`, never `setWorkspaces(next)` directly. The existing comment at [App.tsx:113-117](../../apps/desktop/src/App.tsx#L113-L117) explains why — there's a real bug that came from skipping this.
- **Drag-reorder is hard to unit-test.** We unit-test only `computeDropIndex`. The drag UX is verified by Task 7.2 step 5.
- **Color submenu submenu-positioning** is "good enough", not pixel-perfect. If it overflows on edge cases, it flips; that's the spec.
- **`SESSION_PALETTE` is reused for tab colors.** Don't introduce a parallel palette; the spec explicitly chose this for consistency with session-overlay coloring.
- **The bundle format is a template** for future CSV / math-channel sharing. Don't change `kind: "helios-workspace-bundle"` or `version: 1` lightly — use a new `kind` for new artifact types.
- **`@tauri-apps/plugin-fs` permissions** are scoped to the dialog-returned absolute path. We do NOT add scope rules for arbitrary FS access; that would be a security regression.
