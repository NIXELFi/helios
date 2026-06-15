# Bug/Feature Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Use @superpowers:test-driven-development for every code task.

**Goal:** A sidebar Bug/Feature Report control that lets any signed-in user file a report in seconds, auto-attaching app version, OS, active module, an optional native screenshot, and a rolling breadcrumb trail; reports persist to Supabase `support.reports`; admins triage them in an in-app viewer.

**Architecture:** Frontend-first. A framework-free breadcrumb ring buffer (`lib/breadcrumbs.ts`) fed by passive global capture + Shell nav + ErrorBoundary. A Shell-mounted `ReportModal` (snapshot diagnostics at open) and admin-only `ReportsViewer`, wired through three new `ModulePicker` props. Native screenshot via a Rust `xcap` Tauri command. The `support` schema migration is written now but **applied later in the Supabase pass** (needs the SB token; no Docker here), so insert/select are inert until then — every task is verifiable locally without a live DB.

**Tech Stack:** React 18 + TypeScript + Vitest/testing-library, Tauri v2 (Rust, `xcap` crate), Supabase (Postgres + Storage), Tailwind.

**Spec:** `docs/superpowers/specs/2026-06-15-bug-feature-report-design.md`

**Local gates (run from `apps/desktop`):** `pnpm typecheck` · `pnpm test` · `pnpm exec vitest run <file>` · `cargo check` (in `src-tauri`). The pre-commit hook runs the physics parity suite (~2 min) on every commit — expected, let it run.

**Conventions to follow:** modal a11y recipe from `components/EditUserDialog.tsx` / `modules/vault/components/RowActions.tsx` (`CheckInCommentModal`) — `role="dialog"`, Escape-to-close, focus-on-open, focus-restore. Auth via `useHeliosAuth()` → `{ client, user }`. Keep commit messages simple (no `/` or `\` — they break `git commit -m` arg parsing in this shell; use plain words).

---

## File Structure

| File | Responsibility |
| --- | --- |
| `apps/desktop/src/lib/breadcrumbs.ts` (new) | Ring buffer + `recordBreadcrumb`/`getBreadcrumbs`/`recordLastError`/`getLastError`/`installGlobalCapture` |
| `apps/desktop/src/lib/__tests__/breadcrumbs.test.ts` (new) | Unit tests for the buffer + capture |
| `apps/desktop/src/lib/screenshot.ts` (new) | TS wrapper over the capture command → `Blob \| null` |
| `apps/desktop/src-tauri/src/commands/screenshot.rs` (new) | `capture_app_screenshot` Tauri command (xcap → PNG bytes) |
| `apps/desktop/src-tauri/src/commands/mod.rs` (modify) | `pub mod screenshot;` |
| `apps/desktop/src-tauri/src/lib.rs` (modify ~204) | register `commands::screenshot::capture_app_screenshot` |
| `apps/desktop/src-tauri/Cargo.toml` (modify) | add `xcap` |
| `apps/desktop/src/shell/report/types.ts` (new) | shared `ReportKind`, `ReportDraft`, `ReportRow`, `Breadcrumb` types |
| `apps/desktop/src/shell/report/useSubmitReport.ts` (new) | upload-then-insert submit hook |
| `apps/desktop/src/shell/report/useSubmitReport.test.ts` (new) | hook tests (order, payload, screenshot-path) |
| `apps/desktop/src/shell/report/ReportModal.tsx` (new) | the report form modal |
| `apps/desktop/src/shell/report/ReportModal.test.tsx` (new) | modal tests |
| `apps/desktop/src/shell/report/useReports.ts` (new) | admin list + status update hook |
| `apps/desktop/src/shell/report/ReportsViewer.tsx` (new) | admin-only viewer modal |
| `apps/desktop/src/shell/ModulePicker.tsx` (modify) | new report section + button (expanded + collapsed) |
| `apps/desktop/src/Shell.tsx` (modify) | mount modals, state, pass props, nav breadcrumb |
| `apps/desktop/src/components/ErrorBoundary.tsx` (modify) | `recordLastError` + breadcrumb on catch |
| `apps/desktop/src/main.tsx` (modify) | `installGlobalCapture()` once at boot |
| `infra/pdm-supabase/supabase/migrations/20260615000000_support_reports.sql` (new) | schema + RLS + bucket (APPLIED in Supabase pass) |

---

## Task 1: Breadcrumb buffer (pure core)

**Files:**
- Create: `apps/desktop/src/lib/breadcrumbs.ts`
- Test: `apps/desktop/src/lib/__tests__/breadcrumbs.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// breadcrumbs.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { recordBreadcrumb, getBreadcrumbs, clearBreadcrumbs, recordLastError, getLastError, MAX_BREADCRUMBS } from "../breadcrumbs";

describe("breadcrumbs", () => {
  beforeEach(() => clearBreadcrumbs());

  it("records in order, newest last", () => {
    recordBreadcrumb("nav", "a");
    recordBreadcrumb("action", "b");
    const b = getBreadcrumbs();
    expect(b.map((e) => e.message)).toEqual(["a", "b"]);
    expect(b[0].category).toBe("nav");
    expect(typeof b[0].t).toBe("string");
  });

  it("caps at MAX_BREADCRUMBS, dropping oldest", () => {
    for (let i = 0; i < MAX_BREADCRUMBS + 10; i++) recordBreadcrumb("action", `m${i}`);
    const b = getBreadcrumbs();
    expect(b.length).toBe(MAX_BREADCRUMBS);
    expect(b[0].message).toBe(`m10`);
    expect(b[b.length - 1].message).toBe(`m${MAX_BREADCRUMBS + 9}`);
  });

  it("never throws on unserializable data", () => {
    const circular: any = {}; circular.self = circular;
    expect(() => recordBreadcrumb("error", "boom", circular)).not.toThrow();
    expect(getBreadcrumbs().length).toBe(1);
  });

  it("recordLastError stores the latest structured error", () => {
    recordLastError({ label: "CFD", message: "x", componentStack: "..." });
    expect(getLastError()?.label).toBe("CFD");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd apps/desktop && pnpm exec vitest run src/lib/__tests__/breadcrumbs.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// breadcrumbs.ts
export const MAX_BREADCRUMBS = 50;

export type BreadcrumbCategory = "nav" | "action" | "console" | "error";
export interface Breadcrumb { t: string; category: BreadcrumbCategory; message: string; data?: unknown; }
export interface LastError { label?: string; message: string; componentStack?: string; t: string; }

const buffer: Breadcrumb[] = [];
let lastError: LastError | null = null;

/** Best-effort, never throws. `data` is shallow-stringified + truncated so a
 *  huge or circular object can't bloat the row or crash the recorder. */
export function recordBreadcrumb(category: BreadcrumbCategory, message: string, data?: unknown): void {
  try {
    const entry: Breadcrumb = { t: new Date().toISOString(), category, message: String(message).slice(0, 300) };
    if (data !== undefined) entry.data = safeData(data);
    buffer.push(entry);
    while (buffer.length > MAX_BREADCRUMBS) buffer.shift();
  } catch { /* recording must never break app code */ }
}

export function getBreadcrumbs(): Breadcrumb[] { return buffer.slice(); }
export function clearBreadcrumbs(): void { buffer.length = 0; lastError = null; }

export function recordLastError(e: { label?: string; message: string; componentStack?: string }): void {
  try { lastError = { ...e, message: String(e.message).slice(0, 500), t: new Date().toISOString() }; } catch { /* ignore */ }
}
export function getLastError(): LastError | null { return lastError; }

function safeData(data: unknown): unknown {
  try { return JSON.parse(JSON.stringify(data, replacer())); } catch { return String(data).slice(0, 300); }
}
function replacer() {
  const seen = new WeakSet();
  return (_k: string, v: unknown) => {
    if (typeof v === "object" && v !== null) { if (seen.has(v)) return "[circular]"; seen.add(v); }
    if (typeof v === "string") return v.slice(0, 300);
    return v;
  };
}

let installed = false;
/** Install passive global error/console capture exactly once. Safe to call
 *  multiple times. Each wrapper ALWAYS delegates to the original. */
export function installGlobalCapture(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (e) =>
    recordBreadcrumb("error", `window.error: ${e.message}`, { filename: e.filename, lineno: e.lineno }));
  window.addEventListener("unhandledrejection", (e) =>
    recordBreadcrumb("error", `unhandledrejection: ${String((e as PromiseRejectionEvent).reason)}`));
  for (const level of ["error", "warn"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      recordBreadcrumb("console", `console.${level}: ${args.map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : "")).join(" ").slice(0, 300)}`);
      orig(...args);
    };
  }
}
```

- [ ] **Step 4: Run to verify pass** — same command → PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/breadcrumbs.ts apps/desktop/src/lib/__tests__/breadcrumbs.test.ts
git commit -m "feat(report): breadcrumb ring buffer + global error capture"
```

---

## Task 2: Wire breadcrumb producers (boot, nav, ErrorBoundary)

**Files:**
- Modify: `apps/desktop/src/main.tsx` (call `installGlobalCapture()` before render)
- Modify: `apps/desktop/src/Shell.tsx` (record `nav` on `active` change)
- Modify: `apps/desktop/src/components/ErrorBoundary.tsx` (`recordLastError` + breadcrumb in `componentDidCatch`)
- Modify: `apps/desktop/src/modules/vault/components/RowActions.tsx` (a few manual `action` breadcrumbs — per the spec's "Other producers")

- [ ] **Step 1:** In `main.tsx`, import and call `installGlobalCapture()` once, before `ReactDOM.createRoot(...).render(...)`.
- [ ] **Step 2:** In `Shell.tsx` `HeliosShell`, add an effect that records nav:

```tsx
import { recordBreadcrumb } from "./lib/breadcrumbs";
// ...
useEffect(() => { recordBreadcrumb("nav", `module -> ${active}`); }, [active]);
```

- [ ] **Step 3:** In `ErrorBoundary.componentDidCatch`, after the existing `console.error`, add:

```tsx
import { recordBreadcrumb, recordLastError } from "../lib/breadcrumbs";
// inside componentDidCatch(error, info):
recordLastError({ label: this.props.label, message: error.message || String(error), componentStack: info.componentStack ?? undefined });
recordBreadcrumb("error", `ErrorBoundary${this.props.label ? ` [${this.props.label}]` : ""}: ${error.message || String(error)}`);
```

- [ ] **Step 3b: High-signal Vault breadcrumbs** — in `apps/desktop/src/modules/vault/components/RowActions.tsx`, add one terse `recordBreadcrumb("action", …)` to each hot handler (CheckOut `handleClick`, CheckIn `submit`, Cancel `doRelease` / `doDiscardDraft`), e.g. `recordBreadcrumb("action", \`vault: check-out ${fileName ?? "file"}\`)`. Short messages, no file contents.

- [ ] **Step 4: Verify** — `pnpm typecheck` → clean. (No new unit test; this is wiring covered by Task 1's unit tests + Task 5's modal test reading the buffer.)
- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main.tsx apps/desktop/src/Shell.tsx apps/desktop/src/components/ErrorBoundary.tsx
git commit -m "feat(report): feed breadcrumbs from boot, navigation, and ErrorBoundary"
```

---

## Task 3: Native screenshot command + TS wrapper

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml` (add `xcap`)
- Create: `apps/desktop/src-tauri/src/commands/screenshot.rs`
- Modify: `apps/desktop/src-tauri/src/commands/mod.rs` (`pub mod screenshot;`)
- Modify: `apps/desktop/src-tauri/src/lib.rs` (register in `generate_handler!`, ~line 204)
- Create: `apps/desktop/src/lib/screenshot.ts`

- [ ] **Step 1:** Add to `Cargo.toml` `[dependencies]`:

```toml
# Native window screenshot for bug reports (captures WebGL/canvas too).
xcap = "0.0.14"
```

> If `cargo check` reports the version doesn't resolve or the API differs, bump to the latest `xcap` and adjust the capture call — `cargo check` is the gate. xcap exposes `xcap::Window::all() -> Result<Vec<Window>>`, each with `.app_name()`/`.title()` and `.capture_image() -> Result<image::RgbaImage>`.

- [ ] **Step 2:** Implement `commands/screenshot.rs`:

```rust
//! Native screenshot for the in-app bug report. Captures the real window pixels
//! (incl. WebGL/canvas content the DOM doesn't expose) and returns PNG bytes.
use std::io::Cursor;
use tauri::{command, Window};

#[command]
pub fn capture_app_screenshot(window: Window) -> Result<Vec<u8>, String> {
    let target = window.title().unwrap_or_default();
    let windows = xcap::Window::all().map_err(|e| format!("enumerate windows: {e}"))?;
    // Prefer the window whose title matches ours; fall back to the first
    // Helios window, then bail with a clear error the UI degrades on.
    let win = windows
        .iter()
        .find(|w| w.title() == target && !target.is_empty())
        .or_else(|| windows.iter().find(|w| w.app_name().to_lowercase().contains("helios")))
        .ok_or_else(|| "Helios window not found for capture".to_string())?;
    let img = win.capture_image().map_err(|e| format!("capture: {e}"))?; // RgbaImage
    let mut bytes: Vec<u8> = Vec::new();
    // RgbaImage has no direct write_to; wrap in DynamicImage first.
    xcap::image::DynamicImage::ImageRgba8(img)
        .write_to(&mut Cursor::new(&mut bytes), xcap::image::ImageFormat::Png)
        .map_err(|e| format!("encode png: {e}"))?;
    Ok(bytes)
}
```

> The PNG encoder comes from the `image` crate, which `xcap` re-exports as
> `xcap::image` (used above — no separate dependency needed). If you prefer a
> standalone dep, add `image = "0.25"` to Cargo.toml and use bare `image::` paths
> instead. `cargo check` is the gate; if the `xcap` window API differs from
> `Window::all()` / `.title()` / `.app_name()` / `.capture_image()`, adjust to
> the pinned version's surface.

- [ ] **Step 3:** `commands/mod.rs` → add `pub mod screenshot;`. `lib.rs` → add `commands::screenshot::capture_app_screenshot,` to the `generate_handler!` list (after `reveal::reveal_in_explorer,`).
- [ ] **Step 4:** Implement `lib/screenshot.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";
import { recordBreadcrumb } from "./breadcrumbs";

/** Capture the app window as a PNG Blob. Best-effort: returns null on any
 *  failure (capture must never block filing a report). */
export async function captureScreenshot(): Promise<Blob | null> {
  try {
    const bytes = await invoke<number[]>("capture_app_screenshot");
    return new Blob([new Uint8Array(bytes)], { type: "image/png" });
  } catch (e) {
    recordBreadcrumb("error", `screenshot capture failed: ${String(e)}`);
    return null;
  }
}
```

- [ ] **Step 5: Verify** — `cd apps/desktop/src-tauri && cargo check` → clean (resolve any xcap API drift here). Then `cd .. && pnpm typecheck` → clean.
- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/src/commands/screenshot.rs apps/desktop/src-tauri/src/commands/mod.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src/lib/screenshot.ts
git commit -m "feat(report): native window screenshot command + TS wrapper"
```

---

## Task 4: Shared types + submit hook

**Files:**
- Create: `apps/desktop/src/shell/report/types.ts`
- Create: `apps/desktop/src/shell/report/useSubmitReport.ts`
- Test: `apps/desktop/src/shell/report/useSubmitReport.test.ts`

- [ ] **Step 1:** `types.ts`:

```ts
import type { Breadcrumb, LastError } from "../../lib/breadcrumbs";
export type ReportKind = "bug" | "feature";
export interface ReportDraft {
  kind: ReportKind;
  severity: string;
  title: string;
  what_doing: string;
  details: string;
}
export interface ReportDiagnostics {
  module: string; app_version: string; os: string;
  breadcrumbs: Breadcrumb[]; last_error: LastError | null;
}
export interface ReportRow extends ReportDraft {
  id: string; created_at: string; reporter_id: string;
  module: string | null; app_version: string | null; os: string | null;
  breadcrumbs: Breadcrumb[]; last_error: LastError | null;
  screenshot_path: string | null; status: "new" | "triaged" | "fixed";
}
```

- [ ] **Step 2: Write failing tests** for `useSubmitReport`. Mock a Supabase client with `storage.from().upload()` and `from("reports").insert()`. Assert: (a) with a screenshot, `upload` is called before `insert` and the inserted row's `screenshot_path` is the uploaded key; (b) without a screenshot, `upload` is NOT called and `screenshot_path` is null; (c) the inserted payload includes `kind/severity/title/module/app_version/os/breadcrumbs`; (d) an `insert` error is returned and surfaced (no throw). Use `@testing-library/react`'s `renderHook` + `act` (already used in the repo).

```ts
// shape sketch — assert call order via a shared mock log
expect(mock.calls).toEqual(["upload", "insert"]);
expect(inserted.screenshot_path).toMatch(/^[0-9a-f-]+\.png$/);
```

- [ ] **Step 3:** Run → FAIL.
- [ ] **Step 4:** Implement `useSubmitReport.ts`:

```ts
import { useState } from "react";
import { useHeliosAuth } from "../../auth/AuthShell";
import type { ReportDraft, ReportDiagnostics } from "./types";

const BUCKET = "report-attachments";

export function useSubmitReport() {
  const { client, user } = useHeliosAuth();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(draft: ReportDraft, diag: ReportDiagnostics, screenshot: Blob | null): Promise<boolean> {
    if (!client || !user) { setError("You must be signed in to file a report."); return false; }
    setSubmitting(true); setError(null);
    try {
      let screenshot_path: string | null = null;
      if (screenshot) {
        const key = `${crypto.randomUUID()}.png`;
        const { error: upErr } = await client.storage.from(BUCKET).upload(key, screenshot, { contentType: "image/png" });
        if (upErr) { setError(`Screenshot upload failed: ${upErr.message}`); return false; }
        screenshot_path = key;
      }
      // The app's Supabase client defaults to the `pdm` schema, so a bare
      // client.from("reports") would look in pdm. Override per-call to reach
      // support.reports.
      const { error: insErr } = await ((client as any).schema("support").from("reports")).insert({
        kind: draft.kind, severity: draft.severity, title: draft.title.trim(),
        what_doing: draft.what_doing.trim() || null, details: draft.details.trim() || null,
        module: diag.module, app_version: diag.app_version, os: diag.os,
        breadcrumbs: diag.breadcrumbs, last_error: diag.last_error, screenshot_path,
      });
      if (insErr) { setError(insErr.message); return false; }
      return true;
    } finally { setSubmitting(false); }
  }
  return { submit, submitting, error };
}
```

> **Schema routing (resolved):** the app's Supabase client hard-codes
> `db: { schema: "pdm" }` (`packages/auth/src/client.ts`), so `client.from("reports")`
> would hit `pdm`, not `support`. The fix (above, and in `useReports`) is the
> per-call override `client.schema("support").from("reports")` — supported by
> supabase-js. The Storage call (`client.storage.from(BUCKET)`) is
> schema-independent. **Two Supabase-pass prerequisites** for this to resolve at
> runtime: (1) apply the `support` migration; (2) **add `support` to PostgREST's
> exposed schemas** (Supabase dashboard → Project Settings → API → Exposed
> schemas, or the `pgrst.db_schemas` config) — otherwise `.schema("support")`
> 404s. Until both are done the call is inert; tests mock the client so they
> pass regardless. (Alternative if exposing a schema is undesirable: a
> `SECURITY DEFINER` RPC in the already-exposed `pdm` schema, called via
> `client.rpc(...)` — same pattern as `pdm_object_exists`.)

- [ ] **Step 5:** Run → PASS. `pnpm typecheck` → clean.
- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/shell/report/types.ts apps/desktop/src/shell/report/useSubmitReport.ts apps/desktop/src/shell/report/useSubmitReport.test.ts
git commit -m "feat(report): submit hook (upload-then-insert) + shared types"
```

---

## Task 5: Report modal

**Files:**
- Create: `apps/desktop/src/shell/report/ReportModal.tsx`
- Test: `apps/desktop/src/shell/report/ReportModal.test.tsx`

Behavior: snapshot `getBreadcrumbs()`/`getLastError()` + props (`module`, `appVersion`) once on mount (`useState(() => …)`); form with type toggle, severity select (options switch by type), title (required), "what were you doing" (placeholder names the module), details, "Attach screenshot" button (calls `captureScreenshot`, shows thumbnail + remove), collapsible read-only "Diagnostics included" preview rendering the snapshot. Submit disabled until title non-empty; on submit call `useSubmitReport().submit`; on success show an in-modal "Thanks — report sent" state then auto-close after ~1s; on failure show the error and keep inputs. Follow the `CheckInCommentModal`/`EditUserDialog` a11y recipe (role=dialog, Escape, focus-on-open, focus-restore).

- [ ] **Step 1: Write failing tests** (`ReportModal.test.tsx`, testing-library):
  - renders with type defaulted from the `kind` prop; severity options match type
  - submit button disabled with empty title, enabled after typing a title
  - diagnostics preview shows the module + at least one seeded breadcrumb (seed via `recordBreadcrumb` before render)
  - clicking submit calls a mocked `submit` with the typed draft + snapshot diagnostics
  - when the mocked `submit` resolves false with an error, the error renders and the title input still holds its value
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `ReportModal.tsx` per the behavior above (mock-friendly: accept `onClose`, `kind`, `module`, `appVersion` props; read `os` from `navigator.platform` or a small `lib/platform` helper).
- [ ] **Step 4:** Run → PASS. `pnpm typecheck` → clean.
- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/shell/report/ReportModal.tsx apps/desktop/src/shell/report/ReportModal.test.tsx
git commit -m "feat(report): report modal with diagnostics snapshot + screenshot"
```

---

## Task 6: Sidebar entry + Shell wiring

**Files:**
- Modify: `apps/desktop/src/shell/ModulePicker.tsx` (new section between `PresencePanel` and `UserPill`; 3 new props)
- Modify: `apps/desktop/src/Shell.tsx` (state + mount `ReportModal`; pass props)

- [ ] **Step 1:** `ModulePicker` — add props `onOpenReport: (kind: ReportKind) => void`, `canViewReports: boolean`, `onOpenReports: () => void`. Insert a NEW sibling `<div>` **immediately above** the existing `<div className="border-t border-helios-line p-2">` that wraps `UserPill` (≈ line 240) — a separate sibling, NOT nested inside it (nesting would double the border/padding):

```tsx
<div className="border-t border-helios-line p-2">
  <ReportRailButton collapsed={collapsed} canViewReports={canViewReports}
    onOpenReport={onOpenReport} onOpenReports={onOpenReports} />
</div>
```

Implement `ReportRailButton` (local component): expanded = a "Report a bug" button (calls `onOpenReport("bug")`) with a small caret menu offering Bug/Feature; admin-only quiet "View reports" link below (`onOpenReports`). Collapsed = icon-only button + tooltip. Mirror `NavButton`/`UserPill` collapsed treatment and focus-ring classes.

- [ ] **Step 2:** `Shell.tsx` — add state `const [report, setReport] = useState<ReportKind | null>(null)` and `const [reportsOpen, setReportsOpen] = useState(false)`. Pass to `ModulePicker`: `onOpenReport={setReport}`, `canViewReports={myRole === "owner" || myRole === "admin"}`, `onOpenReports={() => setReportsOpen(true)}`. Mount near `AuthModal`:

```tsx
{report && (
  <ReportModal kind={report} module={active} appVersion={appVersion} onClose={() => setReport(null)} />
)}
```

- [ ] **Step 3: Verify** — `pnpm typecheck` → clean; `pnpm exec vitest run src/shell` (and the report tests) → PASS. Manually confirm placement reasoning (button sits directly above the user pill).
- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/shell/ModulePicker.tsx apps/desktop/src/Shell.tsx
git commit -m "feat(report): sidebar report button above the user pill + shell wiring"
```

---

## Task 7: Admin viewer

**Files:**
- Create: `apps/desktop/src/shell/report/useReports.ts` (admin list + `setStatus`)
- Create: `apps/desktop/src/shell/report/ReportsViewer.tsx`
- Modify: `apps/desktop/src/Shell.tsx` (mount `ReportsViewer` when `reportsOpen`)
- Test: `apps/desktop/src/shell/report/useReports.test.ts` (mock client: lists rows; `setStatus` calls update with id+status)

- [ ] **Step 1: Write failing test** for `useReports` (mock client `from("reports").select()` returns rows; `setStatus(id, "fixed")` issues an update). Run → FAIL.
- [ ] **Step 2:** Implement `useReports.ts` (select newest-first; `setStatus` → `.update({status}).eq("id", id)`; expose `reports`, `loading`, `error`, `refetch`, `setStatus`).
- [ ] **Step 3:** Implement `ReportsViewer.tsx`: admin-only modal (the Shell only renders it for admins, but also guard inside), newest-first list, filter by status/type, expandable rows showing diagnostics + `last_error` + screenshot via `client.storage.from("report-attachments").createSignedUrl(path, 300)`, and a status dropdown wired to `setStatus`. Modal a11y recipe.
- [ ] **Step 4:** In `Shell.tsx`, mount: `{reportsOpen && <ReportsViewer onClose={() => setReportsOpen(false)} />}`.
- [ ] **Step 5: Verify** — hook test PASS; `pnpm typecheck` clean.
- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/shell/report/useReports.ts apps/desktop/src/shell/report/ReportsViewer.tsx apps/desktop/src/Shell.tsx apps/desktop/src/shell/report/useReports.test.ts
git commit -m "feat(report): admin-only reports viewer with status triage"
```

---

## Task 8: Backend migration FILE (applied in the Supabase pass)

**Files:**
- Create: `infra/pdm-supabase/supabase/migrations/20260615000000_support_reports.sql`

> NOT applied here. This is the mirror file; it is applied + validated (RLS suite) during the Supabase pass with the SB token. No local DB test. **Also during the Supabase pass:** expose the `support` schema in the project's API settings (PostgREST exposed schemas) so the client's `.schema("support")` calls resolve.

- [ ] **Step 1:** Write the migration: `create schema support`; the `support.reports` table (columns per the spec; `reporter_id ... default auth.uid()`; `status` check; **no** `severity` check); `alter table ... enable row level security`; policies — insert (authenticated, `reporter_id = auth.uid()`), select (`pdm.is_admin()` OR `reporter_id = auth.uid()`), update (`pdm.is_admin()`); `revoke ... from anon, public` and `grant ... to authenticated` per the pdm convention; create the private Storage bucket `report-attachments` + storage policies (insert authenticated; select admin-or-owner via the object's report row). Mirror idioms from an existing migration (e.g. `infra/pdm-supabase/supabase/migrations/20260531000000_pdm_per_vault_roles.sql` for SECURITY DEFINER/grant patterns).
- [ ] **Step 2: Verify** — file lints as SQL by eye; cross-check column names against `types.ts` `ReportRow`. (Application/validation deferred to the Supabase pass.)
- [ ] **Step 3: Commit**

```bash
git add infra/pdm-supabase/supabase/migrations/20260615000000_support_reports.sql
git commit -m "feat(report): support.reports migration (apply in Supabase pass)"
```

---

## Task 9: Full verification + branch sanity

- [ ] **Step 1:** From `apps/desktop`: `pnpm typecheck` → clean.
- [ ] **Step 2:** `pnpm test` → all pass (note the pre-existing CFD teardown-race unhandled error is unrelated; new report tests green).
- [ ] **Step 3:** `cd src-tauri && cargo check` → clean.
- [ ] **Step 4:** `git status` clean; review `git log --oneline` for the feature commits.
- [ ] **Step 5:** Update `docs/superpowers/plans/2026-06-15-vault-cutover-pre-supabase-HANDOVER.md` (or a short note) to add the `support` migration to the Supabase-pass apply list, and record that the report feature frontend is built-but-inert-until-applied.

```bash
git add -A && git commit -m "docs(report): note support migration in the Supabase-pass apply list"
```

---

## Definition of done (local, no live DB)

- New unit tests pass; full suite green; `tsc` + `cargo check` clean.
- Report button visible above the user pill (expanded + collapsed); modal opens, captures a screenshot, shows the diagnostics snapshot; submit path exercised via mocked client.
- Admin viewer renders and triages via mocked client.
- `support` migration file committed, listed for the Supabase pass.
- Feature is **inert until the migration is applied** — this is expected and documented, not a bug.
