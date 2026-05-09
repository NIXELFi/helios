# Helios Vault — Plan 8: Installer + Mac Packaging

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship-ready installers. The Windows MSI bundles `helios.exe` + `pdm-sync-daemon.exe` + `pdm-shell-ext.dll`, registers the shell extension via `regsvr32` on install, adds an HKCU\Run entry for the daemon, and uninstalls cleanly. The Mac DMG ships only `Helios.app` (no daemon, no shell ext) since Mac is read-only Vault. Auto-update via the existing minisign + GitHub Releases pipeline keeps working for both platforms.

**Architecture:** Tauri 2's NSIS bundler is already used for the Windows installer (`bundle.targets: ["nsis", "msi"]` in `tauri.conf.json`). Extend the NSIS template to also bundle the daemon and shell extension, run `regsvr32` on install, and unregister + remove on uninstall. Mac side: extend the existing DMG bundler config with the `Helios Vault` module assets if any (currently none beyond what's already bundled).

**Tech Stack:** Tauri 2 (existing), NSIS (Windows), DMG (Mac), GitHub Actions (existing release pipeline), minisign (existing).

**Spec:** [`docs/superpowers/specs/2026-05-07-helios-vault-design.md`](../specs/2026-05-07-helios-vault-design.md)
**Roadmap:** [`docs/superpowers/plans/2026-05-07-helios-vault-roadmap.md`](2026-05-07-helios-vault-roadmap.md)
**Depends on:** Plans 6 + 7 (the daemon and shell ext binaries must exist).

---

## File Structure

### Modified files

```
apps/desktop/src-tauri/tauri.conf.json     ← extend bundle.resources to include daemon + shell ext
apps/desktop/src-tauri/installer/
  hooks.nsh                                ← NSIS hooks for install/uninstall (regsvr32, HKCU\Run)
  ...                                      ← any other NSIS includes Tauri picks up via convention

.github/workflows/release.yml              ← (if present) ensure daemon + shell ext are built on Windows runners and bundled into the artifact pipeline
```

### New files

```
apps/desktop/src-tauri/installer/hooks.nsh
docs/INSTALL.md                            ← extend existing INSTALL.md with Vault-related notes (e.g., daemon shows as a tray icon after first launch)
```

---

## Task overview

1. **Locate Tauri's existing bundle config** in `apps/desktop/src-tauri/tauri.conf.json`. Identify where additional binaries can be referenced (the `bundle.resources` and `bundle.externalBin` fields).
2. **Add `pdm-sync-daemon.exe` to `externalBin`.** Tauri auto-bundles external binaries into the installer; they go into the same install directory as `helios.exe`.
3. **Add `pdm-shell-ext.dll` as a bundled resource.** Use `bundle.resources` (or a custom NSIS hook to copy it to the install dir).
4. **Write NSIS install hooks** at `apps/desktop/src-tauri/installer/hooks.nsh`:
   - On install: `ExecWait 'regsvr32 /s "$INSTDIR\pdm-shell-ext.dll"'`. Add HKCU\Software\Microsoft\Windows\CurrentVersion\Run entry pointing at `pdm-sync-daemon.exe`.
   - On uninstall: reverse — `regsvr32 /s /u "$INSTDIR\pdm-shell-ext.dll"`, remove HKCU\Run entry, kill `pdm-sync-daemon.exe` if running.
   - Wire hooks into Tauri's NSIS template via the documented hook-points.
5. **Mac DMG: no changes needed.** Verify the DMG bundle still produces `Helios.app` only.
6. **Update `docs/INSTALL.md`** with a "Vault module on first launch" note for Windows users (e.g., "When you first click Vault, a tray icon for the sync daemon appears in the system tray; this is expected").
7. **Verify auto-update.** The existing minisign + GitHub Releases flow signs the entire bundle. Confirm that the additional binaries are included in the signed bundle so the auto-updater verifies them correctly.
8. **Manual verification on Windows:** download the resulting installer, run it, click through SmartScreen warning, verify shell extension and daemon are installed, run Helios, sign in, perform a check-out / check-in.
9. **Manual verification on Mac:** open the DMG, drag Helios.app to /Applications, click through Gatekeeper warning, run Helios, log in to Vault, browse a vault, verify CAD operations are disabled with the right tooltip.
10. **Plan-completion review** — update roadmap, mark Phase 1 milestone reached.

---

## Conventions

- **No code-signing.** Same policy as existing Helios — see `docs/INSTALL.md`. Users click through SmartScreen / Gatekeeper warnings on first install. Auto-update via minisign-signed Tauri bundles bypasses OS warnings on subsequent updates.
- **Local commits + manual installer build.** No remote push during development; only after manual verification passes do we tag a release (which the existing release pipeline picks up).
- **Tauri auto-update artifacts.** The `latest.json` updater manifest must include the daemon + shell ext file hashes; Tauri handles this automatically when binaries are listed in `externalBin` / `resources`.

---

## Key risks

- **NSIS hook ordering.** `regsvr32` must run AFTER files are copied. Verify with a test install + uninstall cycle.
- **Daemon process holding files open** during uninstall. The uninstaller should `taskkill /F /IM pdm-sync-daemon.exe` before deleting the binary.
- **HKCU\Run vs HKLM\Run.** HKCU is per-user; if multiple Windows accounts share the machine, each user gets their own daemon instance. That's the intended model — documented in the spec's R-2.
- **Mac DMG SHA after additions.** If the Mac bundle changes at all (even unintentionally), the auto-updater's manifest must update. Verify before and after.

---

## What this plan does NOT include

- **Code-signing certificates.** Documented as deferred in the spec.
- **Linux installer.** Existing AppImage workflow for Logs continues to work; the Vault module is functionally a no-op on Linux because the daemon and shell ext are Windows-only. Linux users see "Vault is not configured" if they don't set Supabase env vars. (Reasonable; revisit if anyone on the team uses Linux for CAD review.)
- **Auto-launch the daemon at install time.** The HKCU\Run entry triggers on next login. Users who install and log in have to either log out + back in, or launch Helios manually (which spawns the daemon if not running).
- **Per-machine vs per-user install choice.** Tauri's NSIS defaults to per-user install; we follow that.

---

## Manual verification checklist

- [ ] On a fresh Windows VM, run the installer — confirm SmartScreen warning, then "Run anyway" succeeds.
- [ ] Confirm Helios.exe, pdm-sync-daemon.exe, and pdm-shell-ext.dll all appear under `%LOCALAPPDATA%\Programs\Helios\`.
- [ ] Confirm registry: `HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\ShellIconOverlayIdentifiers\` contains the four overlay registrations.
- [ ] Confirm registry: `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\HeliosVaultDaemon` exists.
- [ ] Launch Helios; confirm Vault module works end-to-end (sign in, browse, check out, check in).
- [ ] Run uninstaller; confirm files, registry entries, and daemon process all cleaned up.
- [ ] On Mac: download DMG, open, drag-and-drop install, click through Gatekeeper, launch Helios, confirm Logs works as before, click Vault, confirm read-only mode (the LoginPane appears once env vars are configured).
- [ ] On both platforms: trigger an auto-update from a previous version → confirm the new bundle replaces the old, daemon picks up after, no SmartScreen / Gatekeeper warning on the update path.

---

## After Plan 8

Phase 1 is complete. The team can begin a real CAD project against the Vault. Phase 2 (SolidWorks add-in) and Phase 3 (suite expansion, SSO, multi-vault, etc.) get their own specs and roadmaps when they're prioritized.

The roadmap document (`docs/superpowers/plans/2026-05-07-helios-vault-roadmap.md`) should be updated one final time with all eight plans marked complete + a celebratory line noting Phase 1 is done.
