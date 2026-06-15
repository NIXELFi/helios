# Bug/Feature Report — Design Spec

**Date:** 2026-06-15
**Branch:** `fix/vault-cutover-pre-supabase`
**Status:** Approved for spec → plan
**Owner:** Sun Devil Motorsports (ASU FSAE)

## Summary

A low-friction **Bug/Feature Report** control in the Helios desktop sidebar that
lets any signed-in user file a report in seconds, while silently attaching the
diagnostic context the developer actually needs to reproduce and fix the issue:
app version, OS, active module, an optional screenshot, and a rolling
**breadcrumb trail** of recent navigation, key actions, console errors, and the
last caught render crash.

Reports land in a new Supabase `support.reports` table (optional screenshot in a
private Storage bucket). Admins/owners get an in-app viewer to triage them
(new → triaged → fixed). The design optimizes for two readers: the **user**
(fast, obvious, transparent about what's attached) and the **developer** (rich,
structured, queryable context).

## Goals

- One-click access from the sidebar, directly above the user's name, visible to
  every signed-in user.
- Capture diagnostics automatically so a report is useful even when the user
  only writes "it broke."
- Be transparent: the user can see exactly what diagnostic data is attached
  before sending.
- Aggregate reports server-side so the developer can query/triage across the
  team.
- Zero PII beyond the reporter's identity and what they type: breadcrumbs record
  **events**, never file contents or payloads.

## Non-Goals (v1)

- Auto-creating GitHub issues (the schema makes this an easy later add).
- Comment threads / back-and-forth on a report.
- Email/Slack notifications on new reports.
- Video / session replay.
- Editing or deleting a submitted report by the reporter.

## Placement (sidebar)

The rail (`apps/desktop/src/shell/ModulePicker.tsx`) is, top-to-bottom:
brand header → module buttons → flex spacer → `PresencePanel` (the "ON HELIOS"
roster, **admin/owner-only**) → `UserPill` (name) → `UpdatesPill`.

The report control is a **new bordered section inserted between the
`PresencePanel` and the `UserPill`** — so it sits directly above the user's name
for everyone. (The presence panel can't be the anchor because it's hidden for
non-admins.)

- **Expanded rail:** a full-width `Report a bug` button. A small caret splits it
  into "Bug" / "Feature" (defaults the report type). Admins/owners get a second,
  quieter "View reports" link below it.
- **Collapsed rail (`w-14`):** icon-only button (bug/feedback glyph), matching
  the `NavButton`/`UserPill` collapsed treatment, with a tooltip.

## Components

### 1. Breadcrumb buffer — `apps/desktop/src/lib/breadcrumbs.ts`

A module-level fixed-size ring buffer (cap ~50). Pure, framework-free, unit
testable.

```ts
type Breadcrumb = { t: string; category: "nav" | "action" | "console" | "error"; message: string; data?: unknown };
function recordBreadcrumb(category, message, data?): void   // append; drop oldest past cap
function getBreadcrumbs(): Breadcrumb[]                      // snapshot (newest last)
function clearBreadcrumbs(): void                            // used by tests
function installGlobalCapture(): void                        // idempotent; called once at boot
```

`installGlobalCapture()` (called from `main.tsx` once):
- `window.addEventListener("error", …)` → record `{category:"error", message, data:{filename,lineno}}`
- `window.addEventListener("unhandledrejection", …)` → record `{category:"error", …}`
- Wrap `console.error` / `console.warn`: record `{category:"console"}` then call through to
  the original. Truncate long args; never serialize huge objects.

Other producers:
- **Shell** records `{category:"nav"}` on `active` module change.
- **`ErrorBoundary.componentDidCatch`** records `{category:"error"}` with
  `{label, message, componentStack}` (this same object becomes the report's
  `last_error`).
- A few **manual** `recordBreadcrumb("action", …)` calls in the hottest module
  (Vault: check-out / check-in / cancel / delete) — high signal, low cost.

`Date.now()`/timestamps come from `new Date().toISOString()` at call time (real
runtime code, unlike the workflow sandbox).

> **Alternatives considered:** fully module-instrumented logging (rejected —
> heavy plumbing, partial coverage) and a telemetry-style structured event bus
> (rejected — overkill for v1). The passive-global + light-manual hybrid gets
> the errors and navigation the developer most needs with a tiny footprint.

### 2. Report modal — `apps/desktop/src/shell/report/ReportModal.tsx`

A focus-trapped, Escape-closable modal (mirrors the app's modal a11y recipe;
`window.confirm` is a no-op in Tauri, so never use it). Fields:

| Field | Control | Default |
| --- | --- | --- |
| Type | Bug / Feature toggle | set by which entry was clicked |
| Severity | select | Bug: blocker/annoying/minor · Feature: important/nice-to-have |
| Title | text input | empty (required) |
| "What were you doing?" | textarea | placeholder hint naming the active module |
| Details | textarea | empty (optional) |
| Screenshot | "Attach screenshot" button + thumbnail/remove | none |
| Diagnostics included | collapsible read-only preview | version, OS, module, breadcrumbs |

Submit flow (`useSubmitReport` hook):
1. If a screenshot is attached, upload PNG to Storage `report-attachments/<uuid>.png`.
2. Insert a `support.reports` row (diagnostics gathered at submit time).
3. Toast "Thanks — report sent."; close. On failure, surface a retry (the typed
   text is preserved).

### 3. Screenshot capture — Rust command

`apps/desktop/src-tauri/src/commands/screenshot.rs`:
`#[tauri::command] capture_app_screenshot(window) -> Result<Vec<u8>, String>` —
captures the Helios window's real pixels (incl. WebGL/canvas in CFD/Games) using
the `xcap` crate (cross-platform: Windows/macOS/Linux), encodes PNG, returns
bytes. Registered in `lib.rs`'s `generate_handler!`. App command (no capability
grant needed; verify on first run).

TS wrapper `apps/desktop/src/lib/screenshot.ts`:
`captureScreenshot(): Promise<Blob | null>` over `invoke("capture_app_screenshot")`,
best-effort (returns null + records a breadcrumb on failure — capture must never
block a report).

> **macOS caveat:** capturing the app's own window via the windowing API should
> not require the Screen Recording (TCC) permission; if `xcap` does trip it on
> macOS, fall back to a "screenshot unavailable" state rather than blocking
> submit. The first macOS build is the real gate (this dev machine is Windows).

### 4. Admin viewer — `apps/desktop/src/shell/report/ReportsViewer.tsx`

Admin/owner-only modal launched from the sidebar "View reports". A newest-first
list with filters (status, type); each row expands to show title, reporter,
module, version/OS, the breadcrumb trail, `last_error`, and the screenshot (via a
short-TTL signed URL). A status dropdown writes `new → triaged → fixed`. RLS is
the real gate; the UI affordance is only shown to admins (defence-in-depth).

### 5. Backend — `support` schema (Supabase)

New migration `infra/pdm-supabase/supabase/migrations/<ts>_support_reports.sql`:

```sql
create schema if not exists support;

create table support.reports (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  reporter_id uuid not null references auth.users default auth.uid(),
  kind text not null check (kind in ('bug','feature')),
  severity text not null,
  title text not null,
  what_doing text,
  details text,
  module text,
  app_version text,
  os text,
  breadcrumbs jsonb not null default '[]'::jsonb,
  last_error jsonb,
  screenshot_path text,
  status text not null default 'new' check (status in ('new','triaged','fixed'))
);
```

RLS (mirrors pdm conventions — revoke anon/public, grant authenticated, admin
check via the existing global-role helper, e.g. `pdm.is_admin()`):
- **insert:** any authenticated user, `reporter_id = auth.uid()`.
- **select:** `pdm.is_admin()` OR `reporter_id = auth.uid()` (reporters see their own).
- **update:** `pdm.is_admin()` only (status triage).
- **delete:** none (or admin-only; default none for v1).

Private Storage bucket `report-attachments`: insert by authenticated users under
the canonical key shape; select scoped to admins or the uploading reporter
(signed URLs for the viewer).

## Data flow

```
user clicks Report ─▶ ReportModal (gather: active module from Shell,
                                    breadcrumbs snapshot, version, OS)
   └─ optional: invoke capture_app_screenshot ─▶ Blob preview
   └─ submit ─▶ [upload PNG to Storage] ─▶ insert support.reports row ─▶ toast
                                                       │
admin ─▶ View reports ─▶ ReportsViewer (RLS-gated select) ─▶ status update
```

`active` module and the auth `client`/`user` are already in `HeliosShell`; the
report section is rendered by `ModulePicker`, so the Shell passes a small
`onOpenReport`/`reportContext` down (same prop pattern as the existing auth/user
props).

## Error handling

- Screenshot capture failure → null, report continues without it.
- Storage upload failure → surface, keep the modal open with typed text intact
  (don't insert a row pointing at a missing object).
- Insert failure → friendly error + retry; typed text preserved.
- Breadcrumb capture is wrapped so it can never throw into app code; the console
  wrapper always delegates to the original even if recording throws.

## Testing

- `breadcrumbs.test.ts`: ring cap/eviction, ordering, console wrapper delegates +
  records, global listeners record, never throws on bad input.
- `ReportModal.test.tsx`: required-field gating, type/severity defaults, submit
  calls upload-then-insert in order, failure preserves input, diagnostics preview
  reflects the buffer.
- `useSubmitReport.test.ts`: payload shape (reporter/module/version/os/breadcrumbs),
  screenshot-path only set when uploaded.
- Rust: `screenshot.rs` returns non-empty PNG bytes for the window (smoke; gated
  to platforms where capture is available).
- Backend RLS suite (runs in the Supabase pass): reporter can insert + read own;
  non-admin can't read others'; admin can read/update all; anon denied.

## Sequencing

- **Now (this branch):** breadcrumbs + global capture, ReportModal + submit hook,
  screenshot command + wrapper, admin viewer, the migration **file**, and tests.
  The frontend is built against the schema but **insert will 404 until the
  migration is applied**.
- **Supabase pass (needs token + validatable stack — no Docker here):** apply the
  `support` migration + bucket via the Management API, commit the mirror, run the
  RLS suite. Only then is the feature live end-to-end. This mirrors how the vault
  DB P0s are staged; it will be called out so the gap isn't mistaken for a bug.

## Risks

- **macOS screenshot permission** (TCC) — see §3 caveat; degrade gracefully.
- **Console wrapping** could interact with other code that also wraps console —
  install once, idempotent, always delegate.
- **Breadcrumb noise** — cap at ~50 and keep messages short so the buffer stays
  readable and the row stays small.
- **Schema drift** — `support` is a brand-new schema (not the drifted `pdm`
  history), so applying it cleanly is low-risk, but still apply via the
  Management API per the standing convention, not `db push`.

## File-by-file (for the plan)

- `apps/desktop/src/lib/breadcrumbs.ts` (+ test)
- `apps/desktop/src/lib/screenshot.ts`
- `apps/desktop/src-tauri/src/commands/screenshot.rs` + register in `lib.rs`; add `xcap` to `Cargo.toml`
- `apps/desktop/src/shell/report/ReportModal.tsx` (+ test)
- `apps/desktop/src/shell/report/ReportsViewer.tsx`
- `apps/desktop/src/shell/report/useSubmitReport.ts` (+ test)
- `apps/desktop/src/shell/report/useReports.ts` (admin list)
- `apps/desktop/src/shell/ModulePicker.tsx` (new section + button)
- `apps/desktop/src/Shell.tsx` (wire context: active module, client/user, modal state; record nav breadcrumb)
- `apps/desktop/src/components/ErrorBoundary.tsx` (record breadcrumb on catch)
- `apps/desktop/src/main.tsx` (installGlobalCapture once)
- `infra/pdm-supabase/supabase/migrations/<ts>_support_reports.sql` (+ mirror; applied in Supabase pass)
