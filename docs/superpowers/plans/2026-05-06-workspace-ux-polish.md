# Workspace UX Polish Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two finishing touches to the v2.3.2 workspace feature: (a) make the tab strip horizontally scrollable + force single-line tabs so a long workspace list never breaks the header, and (b) wire a Photoshop-style "Open with Helios" launch handler for `.helios` files using `tauri-plugin-single-instance`.

**Architecture:**
- **Part 1** is a small CSS/markup change in `WorkspaceTabBar.tsx` — wrap the existing flex row in an `overflow-x-auto` container, add `whitespace-nowrap` to each tab.
- **Part 2** wires `tauri-plugin-single-instance` (Rust + JS) so a second-launch's argv routes to the running first instance via a closure, which emits a Tauri event `helios://open-files` carrying any `.helios` paths. A new `useFileOpener` hook in the frontend listens, reads each file, parses each via the existing `parseBundle`, aggregates the results, and surfaces a single `<ConfirmDialog>` (alert mode if everything's invalid). On confirm, runs `mergeImported` once. A pure helper `formatFileOpenSummary` produces the modal copy and is unit-tested per row of the wording table.

**Tech Stack:** Existing — React 18, Tauri 2, Vitest + jsdom + RTL. New — `tauri-plugin-single-instance` (Rust + JS bindings).

**Spec:** [2026-05-06-workspace-ux-polish-design.md](../specs/2026-05-06-workspace-ux-polish-design.md)

---

## File Structure

### New files

```
apps/desktop/
  src/
    lib/
      file-open-summary.ts       ← pure formatFileOpenSummary({ perFile })
      use-file-opener.ts         ← hook: listen → read → parse → aggregate → expose pending request
  tests/
    file-open-summary.test.ts
    use-file-opener.test.tsx
```

### Modified files

```
apps/desktop/
  package.json                                    ← +@tauri-apps/plugin-single-instance
  src/
    components/
      WorkspaceTabBar.tsx                         ← wrap in overflow-x-auto; whitespace-nowrap on tabs
    App.tsx                                       ← call useFileOpener; on pending → setConfirmState; on confirm → mergeImported
  src-tauri/
    Cargo.toml                                    ← +tauri-plugin-single-instance
    src/lib.rs                                    ← register single-instance + on_page_load emit + get_pending_open_files command
package.json                                       ← bump 2.3.3
Cargo.toml                                         ← bump 2.3.3
apps/desktop/package.json                          ← bump 2.3.3
apps/desktop/src-tauri/tauri.conf.json             ← bump 2.3.3

v2_changes/
  26-workspace-ux-polish.md                       ← change-log entry
  README.md                                       ← +index line
```

---

## Phase 1 — Tab strip overflow (small)

### Task 1.1: Make `WorkspaceTabBar` horizontally scrollable + single-line

**Files:**
- Modify: `apps/desktop/src/components/WorkspaceTabBar.tsx`

- [ ] **Step 1: Find the outer return JSX**

The current outer wrapper is:

```tsx
<div className="ml-2 flex gap-1 items-center">
  <div role="tablist" aria-label="Workspaces" className="flex gap-1 items-center" ...>
    {/* tabs */}
  </div>
  <button>+ New workspace</button>
  <button>Import…</button>
  <button>Export all…</button>
  {menuFor && (() => { ... return <TabContextMenu ... /> })()}
</div>
```

- [ ] **Step 2: Restructure**

Replace with two nested wrappers — outer scrolls, inner keeps the row:

```tsx
<div className="ml-2 flex-1 min-w-0 overflow-x-auto">
  <div className="flex gap-1 items-center w-max">
    <div role="tablist" aria-label="Workspaces" className="flex gap-1 items-center" ...>
      {/* tabs */}
    </div>
    <button>+ New workspace</button>
    <button>Import…</button>
    <button>Export all…</button>
  </div>
  {menuFor && (() => { ... return <TabContextMenu ... /> })()}
</div>
```

The TabContextMenu stays at the OUTER wrapper level (NOT inside the `w-max` inner row), because it's `position: fixed` and shouldn't scroll with the strip.

- [ ] **Step 3: Add `whitespace-nowrap` to each tab button's class string**

In the existing tab `<button>` className concatenation, add `whitespace-nowrap` (after the leading `flex items-center gap-1.5`):

```tsx
className={
  "flex items-center gap-1.5 whitespace-nowrap px-2 py-0.5 text-xs border rounded-sm cursor-pointer transition-colors " +
  ...
}
```

- [ ] **Step 4: Verify existing tests still pass**

```bash
pnpm --filter @helios/desktop test
pnpm --filter @helios/desktop typecheck
```

All 62 tests should still be green. The `WorkspaceTabBar` tests don't assert on overflow behavior, so the tests don't change.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/WorkspaceTabBar.tsx
git commit -m "fix(desktop): WorkspaceTabBar — horizontal scroll + single-line tabs"
```

(Co-author footer mandatory: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.)

---

## Phase 2 — `.helios` launch handler

### Task 2.1: `formatFileOpenSummary` pure helper (TDD)

**Files:**
- Create: `apps/desktop/src/lib/file-open-summary.ts`
- Create: `apps/desktop/tests/file-open-summary.test.ts`

Pure function that takes the aggregated parse result and produces `{ title, body, isAlert }` for the `<ConfirmDialog>`.

- [ ] **Step 1: Write the failing tests**

`apps/desktop/tests/file-open-summary.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatFileOpenSummary, type PerFileResult } from "../src/lib/file-open-summary";
import type { Workspace } from "../src/workspaces/types";

function ws(label: string): Workspace {
  return { id: label, label, color: "#FFC627", tiles: [] };
}
function valid(filename: string, labels: string[]): PerFileResult {
  return { filename, kind: "valid", workspaces: labels.map(ws) };
}
function invalid(filename: string, reason: string): PerFileResult {
  return { filename, kind: "invalid", reason };
}

describe("formatFileOpenSummary", () => {
  it("1 file, 1 workspace", () => {
    const s = formatFileOpenSummary([valid("driver.helios", ["Driver"])]);
    expect(s.isAlert).toBe(false);
    expect(s.title).toBe("Import workspace from driver.helios?");
    expect(s.body).toBe(`"Driver"`);
  });

  it("1 file, N workspaces (N <= 8)", () => {
    const s = formatFileOpenSummary([valid("all.helios", ["A", "B", "C"])]);
    expect(s.title).toBe("Import 3 workspaces from all.helios?");
    expect(s.body).toBe(`"A", "B", "C"`);
  });

  it("1 file, 9 workspaces — body truncates with overflow count", () => {
    const labels = Array.from({ length: 9 }, (_, i) => `W${i + 1}`);
    const s = formatFileOpenSummary([valid("big.helios", labels)]);
    expect(s.title).toBe("Import 9 workspaces from big.helios?");
    expect(s.body).toBe(`"W1", "W2", and 7 more`);
  });

  it("K files (K <= 6), M workspaces", () => {
    const s = formatFileOpenSummary([
      valid("a.helios", ["A"]),
      valid("b.helios", ["B", "C"]),
    ]);
    expect(s.title).toBe("Import 3 workspaces from 2 files?");
    expect(s.body).toBe("a.helios · b.helios");
  });

  it("K files (K > 6), M workspaces — body truncates", () => {
    const files = Array.from({ length: 8 }, (_, i) => valid(`f${i}.helios`, ["x"]));
    const s = formatFileOpenSummary(files);
    expect(s.title).toBe("Import 8 workspaces from 8 files?");
    expect(s.body).toBe("f0.helios · f1.helios · and 6 more");
  });

  it("some files invalid — appends a skipped line", () => {
    const s = formatFileOpenSummary([
      valid("a.helios", ["A"]),
      invalid("bad.helios", "Not a Helios workspace file."),
    ]);
    expect(s.isAlert).toBe(false);
    expect(s.title).toBe("Import workspace from a.helios?");
    expect(s.body).toMatch(/^"A"\n\(1 file\(s\) skipped — not valid Helios bundles\)$/);
  });

  it("all files invalid — alert mode", () => {
    const s = formatFileOpenSummary([
      invalid("bad1.helios", "Not a Helios workspace file."),
      invalid("bad2.helios", "Bundle contains no workspaces."),
    ]);
    expect(s.isAlert).toBe(true);
    expect(s.title).toBe("Could not open");
    expect(s.body).toBe(`"bad1.helios": Not a Helios workspace file.\n"bad2.helios": Bundle contains no workspaces.`);
  });
});
```

- [ ] **Step 2: Run — fail (module missing)**

```bash
pnpm --filter @helios/desktop test
```

- [ ] **Step 3: Implement**

`apps/desktop/src/lib/file-open-summary.ts`:

```ts
import type { Workspace } from "../workspaces/types";

export type PerFileResult =
  | { kind: "valid"; filename: string; workspaces: Workspace[] }
  | { kind: "invalid"; filename: string; reason: string };

export interface FileOpenSummary {
  title: string;
  body: string;
  isAlert: boolean;
}

const MAX_LABELS_INLINE = 8;
const MAX_FILENAMES_INLINE = 6;

export function formatFileOpenSummary(perFile: PerFileResult[]): FileOpenSummary {
  const valid = perFile.filter((r): r is Extract<PerFileResult, { kind: "valid" }> => r.kind === "valid");
  const invalid = perFile.filter((r): r is Extract<PerFileResult, { kind: "invalid" }> => r.kind === "invalid");

  if (valid.length === 0) {
    // Alert mode — every file failed
    return {
      isAlert: true,
      title: "Could not open",
      body: invalid.map((r) => `"${r.filename}": ${r.reason}`).join("\n"),
    };
  }

  const totalWorkspaces = valid.reduce((n, f) => n + f.workspaces.length, 0);
  let title: string;
  let body: string;

  if (valid.length === 1) {
    const f = valid[0]!;
    if (f.workspaces.length === 1) {
      title = `Import workspace from ${f.filename}?`;
    } else {
      title = `Import ${f.workspaces.length} workspaces from ${f.filename}?`;
    }
    const labels = f.workspaces.map((w) => `"${w.label}"`);
    if (labels.length <= MAX_LABELS_INLINE) {
      body = labels.join(", ");
    } else {
      const head = labels.slice(0, 2);
      body = `${head.join(", ")}, and ${labels.length - head.length} more`;
    }
  } else {
    title = `Import ${totalWorkspaces} workspaces from ${valid.length} files?`;
    const filenames = valid.map((f) => f.filename);
    if (filenames.length <= MAX_FILENAMES_INLINE) {
      body = filenames.join(" · ");
    } else {
      const head = filenames.slice(0, 2);
      body = `${head.join(" · ")} · and ${filenames.length - head.length} more`;
    }
  }

  if (invalid.length > 0) {
    body += `\n(${invalid.length} file(s) skipped — not valid Helios bundles)`;
  }

  return { isAlert: false, title, body };
}
```

- [ ] **Step 4: Run — green; commit**

```bash
git add apps/desktop/src/lib/file-open-summary.ts apps/desktop/tests/file-open-summary.test.ts
git commit -m "feat(desktop): formatFileOpenSummary — pure helper for launch-handler modal copy"
```

### Task 2.2: Add `tauri-plugin-single-instance` (JS + Rust)

**Files:**
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/src-tauri/Cargo.toml`

- [ ] **Step 1: Add the JS dep**

```bash
pnpm --filter @helios/desktop add @tauri-apps/plugin-single-instance@^2.0.0
```

- [ ] **Step 2: Add the Rust crate**

In `apps/desktop/src-tauri/Cargo.toml` under `[dependencies]`, append:

```toml
tauri-plugin-single-instance = { version = "2", features = ["semver"] }
```

(`features = ["semver"]` is optional but harmless; if it doesn't exist in the published version, drop it. The plain `= "2"` is the safe minimum.)

- [ ] **Step 3: Verify Rust still compiles (cargo check from src-tauri)**

```bash
cd apps/desktop/src-tauri && cargo check
```

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/package.json pnpm-lock.yaml apps/desktop/src-tauri/Cargo.toml Cargo.lock
git commit -m "chore(desktop): add tauri-plugin-single-instance"
```

### Task 2.3: Wire single-instance + emit `helios://open-files` from Rust

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs`

- [ ] **Step 1: Register the plugin and the on_page_load deferred emit + get_pending_open_files command**

Replace the existing `pub fn run()` body so that:
- A `Mutex<Vec<PathBuf>>` is built before the Builder, holding any first-launch `.helios` paths from `std::env::args()`.
- `tauri_plugin_single_instance::init` is registered with a closure that filters argv for `.helios` paths and emits `helios://open-files` on the main window.
- An `on_page_load` callback drains the mutex's contents and emits the same event after the WebView has finished loading.
- A new Tauri command `get_pending_open_files()` returns and clears the mutex's contents (the safety-net belt #2 fallback).

The new `lib.rs` shape (verbatim):

```rust
mod commands;

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// Holds first-launch .helios paths so the frontend's get_pending_open_files
/// command can drain them if the on_page_load emit raced with React mount.
pub struct PendingOpenFiles(pub Mutex<Vec<String>>);

#[tauri::command]
fn get_pending_open_files(state: tauri::State<'_, PendingOpenFiles>) -> Vec<String> {
    let mut guard = state.0.lock().unwrap();
    let drained: Vec<String> = guard.drain(..).collect();
    drained
}

fn extract_helios_paths<I: IntoIterator<Item = String>>(args: I) -> Vec<String> {
    args.into_iter()
        .filter(|s| {
            let p = std::path::Path::new(s);
            p.extension().map(|e| e.to_ascii_lowercase()) == Some("helios".into())
        })
        .collect()
}

pub fn run() {
    // Snapshot first-launch CLI args (skip argv[0], the executable path).
    let first_launch_paths: Vec<String> = extract_helios_paths(std::env::args().skip(1));
    let pending = PendingOpenFiles(Mutex::new(first_launch_paths.clone()));

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // Second-launch handler: filter argv, emit, and bring window to front.
            let helios_paths: Vec<String> = extract_helios_paths(argv.into_iter().skip(1));
            if !helios_paths.is_empty() {
                let _ = app.emit("helios://open-files", helios_paths);
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
        }))
        .manage(pending)
        .on_page_load(|window, _payload| {
            let app = window.app_handle();
            let state = app.state::<PendingOpenFiles>();
            let mut guard = state.0.lock().unwrap();
            if guard.is_empty() {
                return;
            }
            let drained: Vec<String> = guard.drain(..).collect();
            let _ = window.emit("helios://open-files", drained);
        })
        .invoke_handler(tauri::generate_handler![
            commands::load_csv::load_csv,
            commands::restart::helios_relaunch,
            get_pending_open_files,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Helios");
}
```

Notes for the implementer:
- The `Emitter` and `Manager` traits from `tauri::*` are required for `.emit(...)` and `.get_webview_window(...)` / `.app_handle()` / `.state(...)` calls.
- `tauri::async_runtime::spawn` is NOT used — `on_page_load` runs on the main thread and the work is trivial.
- The `extract_helios_paths` filter is case-insensitive on the extension.
- If `cargo check` complains that `Manager` is unused in this file, drop the import; the methods may all be on `Emitter` now in your installed version. Keep both imports until cargo tells you which is unused, then trim.

- [ ] **Step 2: Verify Rust compiles**

```bash
cd apps/desktop/src-tauri && cargo check
```

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): single-instance handler + on_page_load emit + get_pending_open_files command"
```

### Task 2.4: `useFileOpener` hook (TDD)

**Files:**
- Create: `apps/desktop/src/lib/use-file-opener.ts`
- Create: `apps/desktop/tests/use-file-opener.test.tsx`

The hook subscribes to `helios://open-files`, reads each file, parses each via `parseBundle`, builds `PerFileResult[]`, and calls back to the consumer with the aggregated payload. The consumer (App.tsx) decides what to do with the summary (open the dialog, run mergeImported on confirm).

- [ ] **Step 1: Write the failing tests**

`apps/desktop/tests/use-file-opener.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { useFileOpener } from "../src/lib/use-file-opener";

afterEach(cleanup);

// Mock chain: useFileOpener calls listen() once at mount and invoke()
// (for get_pending_open_files) once at mount, then for each path it calls
// readTextFile().
const eventListeners: Array<(payload: { payload: string[] }) => void> = [];

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_name: string, handler: (payload: { payload: string[] }) => void) => {
    eventListeners.push(handler);
    // Return an unlisten function
    return Promise.resolve(() => {});
  }),
}));

const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => mockInvoke(cmd),
}));

const mockReadTextFile = vi.fn();
vi.mock("@tauri-apps/plugin-fs", () => ({
  readTextFile: (path: string) => mockReadTextFile(path),
}));

const validBundle = (label: string) =>
  JSON.stringify({
    kind: "helios-workspace-bundle",
    version: 1,
    exportedAt: "2026-05-06T00:00:00.000Z",
    exportedFrom: "Helios test",
    workspaces: [{ id: "x", label, color: "#FFC627", tiles: [] }],
  });

function Harness({ onPending }: { onPending: (s: any) => void }) {
  useFileOpener({ onPending });
  return null;
}

describe("useFileOpener", () => {
  beforeEach(() => {
    eventListeners.length = 0;
    mockInvoke.mockReset();
    mockReadTextFile.mockReset();
    // Default: no pending files at mount
    mockInvoke.mockResolvedValue([]);
  });

  it("on event with two valid paths, fires onPending with PerFileResult[]", async () => {
    mockReadTextFile
      .mockResolvedValueOnce(validBundle("A"))
      .mockResolvedValueOnce(validBundle("B"));
    const onPending = vi.fn();
    render(<Harness onPending={onPending} />);
    await waitFor(() => expect(eventListeners.length).toBe(1));

    eventListeners[0]!({ payload: ["/path/a.helios", "/path/b.helios"] });

    await waitFor(() => expect(onPending).toHaveBeenCalled());
    const arg = onPending.mock.calls[0]![0];
    expect(arg.length).toBe(2);
    expect(arg[0]).toMatchObject({ kind: "valid", filename: "a.helios" });
    expect(arg[1]).toMatchObject({ kind: "valid", filename: "b.helios" });
  });

  it("one valid + one invalid yields kind: 'valid' and kind: 'invalid'", async () => {
    mockReadTextFile
      .mockResolvedValueOnce(validBundle("A"))
      .mockResolvedValueOnce("not json {");
    const onPending = vi.fn();
    render(<Harness onPending={onPending} />);
    await waitFor(() => expect(eventListeners.length).toBe(1));

    eventListeners[0]!({ payload: ["/p/a.helios", "/p/b.helios"] });
    await waitFor(() => expect(onPending).toHaveBeenCalled());
    const arg = onPending.mock.calls[0]![0];
    expect(arg[0].kind).toBe("valid");
    expect(arg[1].kind).toBe("invalid");
  });

  it("readTextFile rejection becomes kind: 'invalid' with 'Could not read file' reason", async () => {
    mockReadTextFile.mockRejectedValue(new Error("permission denied"));
    const onPending = vi.fn();
    render(<Harness onPending={onPending} />);
    await waitFor(() => expect(eventListeners.length).toBe(1));

    eventListeners[0]!({ payload: ["/p/a.helios"] });
    await waitFor(() => expect(onPending).toHaveBeenCalled());
    const arg = onPending.mock.calls[0]![0];
    expect(arg[0]).toMatchObject({ kind: "invalid", filename: "a.helios" });
    expect(arg[0].reason).toMatch(/could not read file/i);
  });

  it("at mount, drains get_pending_open_files and processes those paths too", async () => {
    mockInvoke.mockResolvedValue(["/initial/a.helios"]);
    mockReadTextFile.mockResolvedValue(validBundle("A"));
    const onPending = vi.fn();
    render(<Harness onPending={onPending} />);

    await waitFor(() => expect(onPending).toHaveBeenCalled());
    expect(mockInvoke).toHaveBeenCalledWith("get_pending_open_files");
    const arg = onPending.mock.calls[0]![0];
    expect(arg[0]).toMatchObject({ kind: "valid", filename: "a.helios" });
  });
});
```

- [ ] **Step 2: Run — fail (module missing)**

- [ ] **Step 3: Implement**

`apps/desktop/src/lib/use-file-opener.ts`:

```ts
import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { parseBundle } from "./workspace-bundle";
import type { PerFileResult } from "./file-open-summary";

const EVENT_NAME = "helios://open-files";

export interface UseFileOpenerProps {
  onPending: (perFile: PerFileResult[]) => void;
}

/** Subscribes to OS-launched file opens (.helios files via the Tauri single-
 *  instance handler), reads + parses each, and surfaces the aggregated
 *  per-file result to the consumer. The consumer decides what to do (open a
 *  ConfirmDialog, run mergeImported on confirm, etc.).
 *
 *  Race mitigation: at mount, we ALSO call invoke("get_pending_open_files")
 *  to drain any first-launch paths that the on_page_load emit might have
 *  raced past us on. */
export function useFileOpener({ onPending }: UseFileOpenerProps) {
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    async function processPaths(paths: string[]) {
      if (paths.length === 0) return;
      const perFile: PerFileResult[] = await Promise.all(
        paths.map(async (path): Promise<PerFileResult> => {
          const filename = basename(path);
          let text: string;
          try {
            text = await readTextFile(path);
          } catch {
            return { kind: "invalid", filename, reason: "Could not read file." };
          }
          const r = parseBundle(text);
          if (!r.ok) return { kind: "invalid", filename, reason: r.reason };
          return { kind: "valid", filename, workspaces: r.bundle.workspaces };
        }),
      );
      if (!cancelled) onPending(perFile);
    }

    listen<string[]>(EVENT_NAME, (event) => {
      void processPaths(event.payload);
    }).then((u) => {
      unlisten = u;
    });

    // Belt-and-suspenders: drain any pending paths the Rust side queued
    // before we attached the listener. Empty array is a no-op.
    invoke<string[]>("get_pending_open_files")
      .then((paths) => { if (!cancelled) void processPaths(paths); })
      .catch(() => {});

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [onPending]);
}

function basename(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? path;
}
```

- [ ] **Step 4: Run — green; commit**

```bash
git add apps/desktop/src/lib/use-file-opener.ts apps/desktop/tests/use-file-opener.test.tsx
git commit -m "feat(desktop): useFileOpener hook — listen, read, parse, aggregate"
```

### Task 2.5: Wire `useFileOpener` into App.tsx

**Files:**
- Modify: `apps/desktop/src/App.tsx`

- [ ] **Step 1: Add the import + the hook call**

At the top:

```ts
import { useFileOpener } from "./lib/use-file-opener";
import { formatFileOpenSummary } from "./lib/file-open-summary";
import type { PerFileResult } from "./lib/file-open-summary";
```

Inside `App()`, near the other hooks (e.g. after `useUpdater`), add:

```tsx
useFileOpener({
  onPending: handleFileOpenPending,
});
```

- [ ] **Step 2: Implement `handleFileOpenPending`**

After `handleImportWorkspaces`, add:

```tsx
function handleFileOpenPending(perFile: PerFileResult[]) {
  const summary = formatFileOpenSummary(perFile);
  if (summary.isAlert) {
    setConfirmState({
      title: summary.title,
      body: summary.body,
      confirmLabel: "OK",
      confirmTone: "default",
      onConfirm: () => setConfirmState(null),
    });
    return;
  }
  // We snapshot workspaces.length BEFORE commit (same pattern as
  // handleImportWorkspaces — see comment there for why).
  const validBundles = perFile
    .filter((r): r is Extract<PerFileResult, { kind: "valid" }> => r.kind === "valid")
    .flatMap((r) => r.workspaces);
  setConfirmState({
    title: summary.title,
    body: summary.body,
    confirmLabel: "Import",
    confirmTone: "default",
    cancelLabel: "Cancel",
    onConfirm: () => {
      const firstImportedIndex = workspaces.length;
      const merged = mergeImported(workspaces, validBundles);
      commitWorkspaces(() => merged);
      setWorkspaceId(merged[firstImportedIndex]!.id);
      setSelectedTileId(null);
      setConfirmState(null);
    },
  });
}
```

- [ ] **Step 3: Widen `ConfirmRequest.body` to `string | ReactNode` and handle line breaks**

The `body` string returned by `formatFileOpenSummary` may contain `\n` newlines. `<ConfirmDialog>`'s body slot renders `body` inside a `<div>` so HTML collapses newlines to spaces by default. The clean fix:

1. Find the existing `ConfirmRequest` type in `App.tsx` (currently `body: string`). Widen to `body: string | ReactNode`. Add `import type { ReactNode } from "react";` if it's not already there.
2. In `handleFileOpenPending`, wrap the body in a JSX span: `body: <span style={{ whiteSpace: "pre-line" }}>{summary.body}</span>`. Apply to BOTH the alert and confirm branches.

(`<ConfirmDialog>`'s `body` prop type is already `string | ReactNode` from Phase 3 of the prior feature, so no component-level change is needed — only the local `ConfirmRequest` typedef in App.tsx needs widening to match.)

- [ ] **Step 4: Verify tests + typecheck**

```bash
pnpm --filter @helios/desktop test
pnpm --filter @helios/desktop typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/App.tsx
git commit -m "feat(desktop): wire useFileOpener — confirm modal on .helios open"
```

---

## Phase 3 — Polish & ship

### Task 3.1: `v2_changes/26-workspace-ux-polish.md`

**Files:**
- Create: `v2_changes/26-workspace-ux-polish.md`
- Modify: `v2_changes/README.md`

- [ ] **Step 1: Write entry** matching the tone of `v2_changes/25-workspace-management.md` (look at it for structure). Sections: Before / What changed / Files changed.

Cover:
- Tab strip overflow → horizontal scroll + single-line tabs.
- `.helios` launch handler → tauri-plugin-single-instance, on_page_load deferred emit, get_pending_open_files belt #2, Photoshop-style confirm modal.
- Out of scope: macOS launch flow, drag-drop of files into the window, Recent Files menu.

- [ ] **Step 2: Add a line to `v2_changes/README.md`**

```
- [26 — Workspace UX polish](26-workspace-ux-polish.md) — tab-strip horizontal scroll + single-line tabs; .helios file launch handler with single-instance + Photoshop-style confirm
```

- [ ] **Step 3: Commit**

```bash
git add v2_changes/26-workspace-ux-polish.md v2_changes/README.md
git commit -m "docs: v2_changes — workspace UX polish entry"
```

### Task 3.2: Bump to 2.3.3 (DO NOT TAG)

- [ ] **Step 1: Run the bump script**

```bash
node scripts/bump-version.mjs 2.3.3
```

(If the Windows CLI-entrypoint quirk hits — script no-ops silently — fall back to direct dynamic-import workaround as Phase 8 of the previous feature did. The function logic itself is correct.)

- [ ] **Step 2: Verify all four files report 2.3.3**

```bash
node scripts/check-versions.mjs
```

- [ ] **Step 3: Run tests + typecheck**

```bash
pnpm --filter @helios/desktop test
pnpm --filter @helios/desktop typecheck
```

- [ ] **Step 4: Commit (no tag)**

```bash
git add package.json Cargo.toml apps/desktop/package.json apps/desktop/src-tauri/tauri.conf.json
git commit -m "chore: bump to 2.3.3 (workspace UX polish; do not release yet)"
```

**CRITICAL:** Do NOT run `git tag v2.3.3`. Do NOT push tags.

---

## Definition of Done

- All Phase 1–3 tasks complete; all green tests.
- `pnpm --filter @helios/desktop typecheck` clean.
- `cargo check` from `apps/desktop/src-tauri/` clean.
- Manual smoke: spam-create 30 workspaces — header doesn't break, tab strip scrolls, tab labels stay single-line, right-side toolbar reachable.
- Launch handler manual smoke deferred to a packaged build (out of dev's reach without `tauri build`).
- v2_changes/26 + index entry committed.
- Versions bumped to 2.3.3; no git tag created.

---

## Notes for the executor

- **`whitespace-nowrap`** goes ONLY on the tab `<button>`. The `<input>` for inline-rename already has `w-24`; no change.
- **The `<TabContextMenu>` MUST stay at the OUTER wrapper level** (after the `w-max` inner row, not inside it). It's `position: fixed` and shouldn't scroll with the strip.
- **Single-instance closure runs on a non-main thread** — that's why all the Tauri API access in it goes through the `app: AppHandle` argument; do NOT cache the `AppHandle` outside the closure scope.
- **Don't handle the `RunEvent::Opened` macOS path** — out of scope for this version. Spec marks Windows-first; macOS Apple-event handling is a small follow-up.
- **`extract_helios_paths`** must be case-insensitive on the extension (e.g. `Foo.HELIOS` should match) — the implementation uses `to_ascii_lowercase()` to handle this.
- **First-launch path AND single-instance path use the same event name** — by design. Frontend has one listener.
- **Don't change `dragDropEnabled`** — it stays `false`, the prior fix for HTML5 drag-reorder. The launch handler doesn't need OS-level file-drop.
