# Workspace UX Polish — Design Spec

**Date:** 2026-05-06
**Owner:** Sun Devil Motorsports (ASU FSAE)
**Status:** Draft for review
**Target version:** 2.3.3 (do **not** tag/release as part of this work — `v*` tags trigger the GitHub Actions release pipeline)

## Summary

Two finishing touches to the workspace-management feature that landed in 2.3.2:

1. **Tab strip overflow.** The header tab strip has no width cap, so accumulating workspaces pushes the right-side toolbar (Channels, Math, Edit, etc.) off-screen and tabs can break onto a second line. Make the tab area horizontally scrollable and force every tab onto a single line.

2. **"Open with Helios" launch handler.** Phase 1 added `bundle.fileAssociations` for `.helios` files so the OS knows the file type, but double-clicking a `.helios` file with the installed app currently does nothing useful. Wire up a Photoshop-style flow: open Helios (or focus the running instance), then prompt the user with `Import workspace(s) from <filename>?`. On confirm, run the existing `mergeImported` flow.

Bundled into one `v2_changes/26-workspace-ux-polish.md` and shipped as v2.3.3.

## Goals

- Tab strip never breaks header layout, no matter how many workspaces exist. Right-side toolbar always reachable.
- Every workspace tab label stays on a single line.
- Drag-reorder, right-click context menu, inline rename — all continue to work in the scrollable strip.
- Double-clicking a `.helios` file (Windows, installed build) opens Helios (or focuses the existing instance) and surfaces a confirm-to-import modal.
- Multiple `.helios` files selected together (shift-click + Enter) produce one combined confirm modal that imports the lot.
- Malformed or missing files are surfaced with a friendly error modal — never a crash, never silent data loss.
- All confirmation prompts continue to use the existing `<ConfirmDialog>` component (`feedback_no_browser_dialogs.md`).

## Non-Goals (this phase)

- macOS file-open flow (`RunEvent::Opened` / Apple events). The `fileAssociations` config from 2.3.2 already registers the file type at install time; the Rust event handler differs from Windows and is a small Windows-second follow-up.
- Drag-and-drop of `.helios` files into the Helios window. The Phase 1 fix set `dragDropEnabled: false` to make HTML5 drag-reorder work; reversing that without breaking drag-reorder needs a different solution (per-element vs. window-level), out of scope.
- "Recent files" menu / Open Recent submenu.
- Per-file "merge vs replace" toggle in the confirm modal. Imports stay non-destructive (id regen + label dedup) like in-app `Import…`.
- Telemetry on file-open events.
- A universal "Helios bundle" super-format combining workspaces + sessions + math (still the share-bundle memory's future plan).
- Floating / always-pinned `+ New / Import / Export all` buttons. They live inside the scrollable region and scroll with the tabs. Cheap follow-up if it bothers anyone.

## Tech additions

- `tauri-plugin-single-instance@2` (Rust crate)
- `@tauri-apps/plugin-single-instance@^2.0.0` (TypeScript wrapper)

No new JS UI deps. The existing `<ConfirmDialog>` is reused; the existing `parseBundle` and `mergeImported` are reused.

---

## Part 1 — Tab strip overflow

### Change scope

`apps/desktop/src/components/WorkspaceTabBar.tsx`. Wrap today's content in a horizontally-scrollable container; add `whitespace-nowrap` to each tab button.

### Layout

Today (top-level `<div>` of the component):

```tsx
<div className="ml-2 flex gap-1 items-center">
  <div role="tablist" ...>{/* tabs */}</div>
  <button>+ New workspace</button>
  <button>Import…</button>
  <button>Export all…</button>
  {menuFor && <TabContextMenu ... />}
</div>
```

Becomes:

```tsx
<div className="ml-2 flex-1 min-w-0 overflow-x-auto">
  <div className="flex gap-1 items-center w-max">
    <div role="tablist" ...>{/* tabs */}</div>
    <button>+ New workspace</button>
    <button>Import…</button>
    <button>Export all…</button>
  </div>
  {menuFor && <TabContextMenu ... />}
</div>
```

- **Outer wrapper** `flex-1 min-w-0 overflow-x-auto`: takes available header width (next to `HELIOS` brand and primary-session label, before `ml-auto` toolbar), clips overflow, scrolls horizontally on the wheel.
- **Inner row** `flex gap-1 items-center w-max`: keeps the row as a single line; `w-max` makes the row as wide as its contents so `overflow-x-auto` actually engages.
- **`<TabContextMenu>` stays at the outer-wrapper level** (NOT inside the inner row) so its `position: fixed` anchor is unaffected by scroll position.

### Single-line tabs

Each tab `<button>` gets `whitespace-nowrap` added to its existing class string. The inner label `<span>` inherits `whitespace-nowrap` so a long label like `"Driver tryout 4/16 — Kaden (good GPS)"` cannot wrap onto a second line and grow header height.

### Side concerns covered

- **Drag-reorder:** Phase 6 polish moved `onDragOver`/`onDrop` onto the tablist `<div>`. Inside the new wrapper, those handlers still work. The only thing scroll position affects is the dropIndex computation (mouseX is viewport-relative; `getBoundingClientRect` returns viewport-relative rects). Already aligned.
- **Drop indicators:** the 2 px yellow vertical bars are flex children inside the inner row. They scroll with the tabs. Fine.
- **Inline rename:** the `<input>` keeps `w-24`. Even if a user types a very long label, the input is fixed width and won't grow the line.
- **Wheel-to-scroll:** Chromium / WebView2 translate vertical wheel to horizontal scroll on `overflow-x-auto` containers when there's no vertical overflow. Tested by user. Click-drag works natively.

---

## Part 2 — Launch handler architecture

### Data flow

```
                    OS file association (Windows/macOS at install)
                              │
         "Open with Helios" ▼            ▼ "Open with Helios" while running
                              │            │
                  ┌───────────▼─────┐ ┌────▼──────────────────────┐
                  │  First launch    │ │  Second launch (single-   │
                  │  (app starts)    │ │  instance redirects to    │
                  │                  │ │  the running instance)    │
                  └───────────┬─────┘ └────┬──────────────────────┘
                              │            │
                              ▼            ▼
                  Rust setup() reads      single-instance handler
                  std::env::args() for    receives argv from the
                  *.helios paths. After   2nd launch. Filters for
                  the window is mounted,  *.helios paths.
                  emits "helios://open-   ────────────────────────
                  files" with the paths.       │
                              │                ▼
                              └─────►   emit "helios://open-files"
                                        on the main window with the
                                        *.helios paths
                                                │
                                                ▼
                          ┌────────────────────────────────────────┐
                          │  Frontend listener                     │
                          │  (new useFileOpener hook)              │
                          │  ────────────────────────────────────  │
                          │  1. listen("helios://open-files")      │
                          │  2. for each path: readTextFile,       │
                          │     parseBundle                        │
                          │  3. aggregate {                        │
                          │       perFile: Array<{ filename,       │
                          │         bundle | error }>,             │
                          │       totalWorkspaces, totalInvalid    │
                          │     }                                  │
                          │  4. open ConfirmDialog with summary    │
                          │     (or alert if everything invalid).  │
                          │     On confirm → mergeImported once    │
                          │     across all valid bundles.          │
                          └────────────────────────────────────────┘
```

Why an event-based bridge instead of a Tauri command: the launch handler is push-driven (Rust pushes the path to JS), not pull-driven (JS asks Rust for the path). Events are the right shape, and they let us deliver the same payload from both code paths (first-launch and single-instance) through one channel.

### File listings

**Modified:**
- `apps/desktop/src-tauri/Cargo.toml` — add `tauri-plugin-single-instance = "2"`
- `apps/desktop/src-tauri/src/lib.rs` — register the plugin with a closure that filters `argv` for `.helios` paths and emits the event; in `setup`, read `std::env::args()` for first-launch paths and emit after window-ready
- `apps/desktop/package.json` — add `@tauri-apps/plugin-single-instance@^2.0.0`
- `apps/desktop/src/App.tsx` — call `useFileOpener` hook; on the hook's `onConfirm`, call `mergeImported` once and switch to the first imported workspace

**New:**
- `apps/desktop/src/lib/use-file-opener.ts` — the hook (tested via RTL)
- `apps/desktop/src/lib/file-open-summary.ts` — pure `formatFileOpenSummary({ perFile })` that produces `{ title, body }` for the confirm modal (unit-tested)
- `apps/desktop/tests/use-file-opener.test.tsx` — RTL coverage of the hook with mocked `@tauri-apps/api/event` and `@tauri-apps/plugin-fs`
- `apps/desktop/tests/file-open-summary.test.ts` — unit coverage of every modal-text branch

### Capability

The existing `fs:allow-read-text-file` (added in Phase 1) covers reading the .helios file. No new capability strings needed.

### Race condition: first-launch event vs. React mount

Tauri's event bus is in-process and synchronous-ish: events emitted before any listener attaches can be lost. Two-belts mitigation:

1. **Defer the emit until after the main window finishes loading.** In `lib.rs`'s `setup`, attach an `on_page_load` callback (or use `WindowEvent::Created`) that schedules the emit. By the time the page has loaded, `useFileOpener` is mounted and has called `listen()`.
2. **Fallback Tauri command `get_pending_open_files()`** returns the contents of a `Mutex<Vec<PathBuf>>` that the Rust handler also writes to. The hook calls this once at mount as a backup path. If the event fires before the listener attaches, the command picks up the buffered paths.

Belt #1 is the primary path; belt #2 is the safety net. Tests will cover belt #2's read-and-clear behavior.

---

## Confirmation modal wording

`<ConfirmDialog>` reused with the body computed by `formatFileOpenSummary`.

| Case | Title | Body |
|---|---|---|
| 1 file, 1 workspace | `Import workspace from <filename>?` | `"<workspace label>"` |
| 1 file, N workspaces (N ≤ 8) | `Import N workspaces from <filename>?` | `"<l1>", "<l2>", "<l3>"` (full list) |
| 1 file, N workspaces (N > 8) | same | `"<l1>", "<l2>", and N more` |
| K files (K ≥ 2), M workspaces (K ≤ 6) | `Import M workspaces from K files?` | `<filename1> · <filename2> · …` (full list) |
| K files (K > 6), M workspaces | same | `<f1> · <f2> · and N more` |
| Some files invalid, but ≥1 valid | append a `(K file(s) skipped — not valid Helios bundles)` line to the body |
| ALL files invalid | uses **alert mode** (no Cancel button). Title: `Could not open` | One line per file: `"<filename>": <reason>` |

Confirm button label: `Import`. Cancel: `Cancel`. Tone: `default` (yellow), not `danger` — import is non-destructive.

Filenames in the modal are basenames (`helios-workspace-driver-tryout.helios`), not full paths.

---

## Edge cases

| Case | Behavior |
|---|---|
| File path doesn't exist (deleted between OS dispatch and React pickup) | Treated as invalid with reason `"File not found"`; included in the skipped count |
| File can't be read (permissions / locked) | Treated as invalid with reason `"Could not read file"`; included in skipped count |
| File has wrong `kind` / `version` / shape | Same as in-app import — `parseBundle` returns the existing friendly reason; included in skipped count |
| User cancels the confirm | No-op. Event payload discarded. |
| Confirm modal already open (e.g. user is mid-Reset confirm when a 2nd-instance event arrives) | The new request displaces the existing `confirmState`. Acceptable: the user just clicked something in the OS that brought Helios to front, so they expect to interact with it next. |
| First-launch event fires before React listener attaches | Belt-and-suspenders: `setup` defers emit until page-loaded, AND the hook polls a `get_pending_open_files()` command at mount as a backup. |
| Multiple `.helios` paths in `argv` mixed with non-`.helios` paths | Filter to only `.helios` extension (case-insensitive) in Rust before emitting. Other paths are silently ignored. |
| Tabs at edit-mode / mid-rename when import fires | Confirm dialog still works; on accept, new tabs append to the right and the active tab switches to the first imported. The existing rename input on a different tab is unaffected. |
| `fs:allow-read-text-file` rejects the path (capability denial) | Caught as `"Could not read file"` reason; skipped. |
| Bundle contains a workspace whose label collides with an existing workspace | `mergeImported` already handles this — appends `" (imported)"`, `" (imported 2)"`, etc. No special UI. |

---

## Testing

### Unit tests (vitest + RTL where applicable)

- **`apps/desktop/tests/file-open-summary.test.ts`** — pure function coverage of every row in the wording table above. Covers: 1-file/1-ws, 1-file/N-ws (≤8 / >8), N-files/M-ws (≤6 / >6), some-skipped, all-skipped (alert mode).
- **`apps/desktop/tests/use-file-opener.test.tsx`** — mocks `@tauri-apps/api/event`'s `listen` and `@tauri-apps/plugin-fs`'s `readTextFile`. Asserts:
  - On a fake `helios://open-files` event with 2 valid paths, the hook's `onPending` callback fires with the aggregated `perFile` payload.
  - One valid + one invalid path → `perFile` has one of each.
  - All paths invalid → `onPending` still fires; the hook caller decides to render alert mode based on the payload.
  - On `onConfirm`, the merge happens once across all valid bundles.

### What's not unit-tested

- The Rust → JS event bridge itself (Tauri APIs aren't available in jsdom — same posture as `workspace-dialog.ts`).
- The `tauri-plugin-single-instance` "redirect 2nd launch to first" behavior — needs a packaged installed build.

### Manual smoke test

To be logged in `v2_changes/26-workspace-ux-polish.md`:

**Tab overflow:**
1. Spam-create 30 workspaces. Confirm:
   - Header layout doesn't break.
   - Tab strip scrolls horizontally with the wheel.
   - Tab labels stay single-line — long labels truncate visually but don't wrap.
   - Right-side toolbar (Channels / Math / Edit / playback / clock) remains reachable.
   - Drag-reorder still works (drag tab 5 to position 25, scroll back and verify the new order persisted across reload).

**Launch handler** (requires a packaged build; `tauri build` produces an installer that registers `.helios` with the OS):
2. Build + install. Verify Explorer shows `.helios` files with Helios's icon and "Helios workspace bundle" type.
3. Double-click a `.helios` file with Helios closed → app opens, confirm modal appears, accept → workspace imported.
4. With Helios already open, double-click another `.helios` file → existing window stays focused (no second instance), confirm modal appears.
5. Shift-select 3 `.helios` files in Explorer, hit Enter → single confirm modal "Import N workspaces from 3 files?".
6. Save a corrupted `.json` file with `.helios` extension, Open with Helios → alert modal "Could not open: not a Helios workspace file".
7. While mid-Reset confirm dialog, double-click a `.helios` file → new modal displaces the Reset one. Cancel returns to no dialog.

---

## Out-of-scope reminders

macOS launch flow, drag-and-drop of files into the window, Recent Files menu, and per-file merge-vs-replace toggle are deferred to follow-up work as documented above.
