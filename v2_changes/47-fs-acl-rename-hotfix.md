# 47 — v3.7.3: hotfix — Vault downloads broken by missing fs ACL grant

**Date:** 2026-05-30

Hotfix for a runtime regression that broke **all Vault downloads** in v3.7.1 and
v3.7.2: clicking Download (or auto-sync) failed with

> Last error: Command plugin:fs|rename not allowed by ACL

## Cause
The v3.7.1 atomic-write fix changed `useDownloadVersion` to write bytes to a
`<dest>.part` temp file and then `rename()` it onto the real destination (with a
best-effort `remove()` of the temp on failure). Tauri v2 gates every plugin
command behind the capability ACL, and `capabilities/default.json` granted
`fs:allow-write-file`/`mkdir`/`stat`/… but **not** `fs:allow-rename` or
`fs:allow-remove`. So the very last step of every download — the rename — was
denied at runtime. The whole test suite mocks `@tauri-apps/plugin-fs`, so the
ACL was never exercised and the regression shipped unseen.

## Fix
- Granted `fs:allow-rename` + `fs:allow-remove` in `capabilities/default.json`
  (the existing `fs:scope` already covers all paths, so no scope change needed).
- Added `tests/capabilities-fs-acl.test.ts` — a guard that reads the real
  capability file and asserts every `plugin:fs` command the app invokes is
  granted, so an fs command without an ACL grant fails CI instead of shipping.

No app code changed; the atomic temp-write + rename behavior is unchanged, it's
now simply permitted.
