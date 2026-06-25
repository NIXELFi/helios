# Sub-project E — MATLAB Engine Bridge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Independent of B/C/D for the bridge mechanics; **public distribution of a MATLAB plugin requires C (consent) + D (review).**

**Goal:** Implement the first curated Tier-2 host bridge — `engine:matlab` — so a sandboxed plugin can run MATLAB programs using the machine's local MATLAB install/license (VS Code-extension style), via a brokered host capability, never by spawning processes itself.

**Architecture:** The A broker already gates `engine.matlab.run` on the `engine:matlab` permission and currently throws "not available". Wire that handler to a new Tauri command `matlab_run(script, inputs)` that locates the local MATLAB, runs the plugin's script **headless and sandboxed in a temp workspace** with a timeout, and returns captured outputs. MATLAB detection + path override live in app settings. The plugin never gets process access; the host owns the entire invocation.

**Tech Stack:** Rust/Tauri command, `matlab -batch` headless subprocess (default transport — see open decisions), a temp-workspace marshaling convention (JSON in/out), the existing A capability framework + SDK `engine.matlab.run`.

---

## Open decisions (resolve first)

1. **Transport:** `matlab -batch "..."` headless subprocess (recommended — simplest, robust, no extra runtime) vs the MATLAB Engine API (C/Python). (Roadmap #5.)
2. **I/O marshaling:** write `inputs` as JSON to the temp workspace and have the wrapper read it / write `output.json`, vs `.mat` files. Recommend JSON for v5.0.0 (simple, debuggable); `.mat` later if numeric fidelity demands it.
3. **MATLAB detection:** auto-detect common install paths + a manual override in settings. Confirm which platforms matter (Windows first; macOS later).
4. **Resource policy:** default timeout (recommend 120 s, configurable), kill-on-timeout, temp-workspace cleanup, concurrent-run cap (recommend 1).
5. **Honest scope note:** running MATLAB = arbitrary native code at the user's privileges. The sandbox protects Helios/DB; it does **not** sandbox MATLAB itself. This is inherent (spec §3) — the controls are the `engine:matlab` permission + install-time consent (C) + human review (D), not OS-level MATLAB sandboxing.

---

## File structure

| File | Responsibility |
|---|---|
| `apps/desktop/src-tauri/src/engines/matlab.rs` | Detect MATLAB, write the temp workspace, run `matlab -batch` with a timeout, collect `output.json`/stdout, clean up. |
| `apps/desktop/src-tauri/src/lib.rs` (modify) | Register `matlab_run`, `matlab_detect`, `matlab_set_path` commands. |
| `apps/desktop/src/modules/marketplace/runtime/capabilityHandlers.ts` (modify) | `engine.matlab.run` handler invokes the `matlab_run` Tauri command instead of throwing. |
| `apps/desktop/src/modules/marketplace/runtime/__tests__/matlabHandler.test.ts` | Test the handler maps params → command and surfaces errors (Tauri `invoke` mocked). |
| `apps/desktop/src/modules/marketplace/settings/MatlabSettings.tsx` | Detect/show/override the MATLAB executable path; "Test connection". (There is no global `src/settings/` dir — settings live per-module, e.g. `modules/vault/screens/SettingsScreen.tsx`; host this under the Marketplace module and surface it from there.) |
| `crates/.../matlab_run` Rust tests | Timeout, temp-workspace isolation, missing-MATLAB error. |

---

## Tasks

### Task E.1 — MATLAB detection + settings
**Files:** Create `src-tauri/src/engines/matlab.rs`; modify `lib.rs`; create `settings/MatlabSettings.tsx`.
- [ ] **Step 1:** In `matlab.rs`, implement `detect() -> Option<PathBuf>` (check `PATH`, common install dirs, a stored override) and a stored-setting for the path. Add Tauri commands `matlab_detect()` and `matlab_set_path(path)`.
- [ ] **Step 2:** `MatlabSettings.tsx`: show detected path, allow override, "Test connection" (runs `matlab -batch "disp('ok')"`). Surface clearly when MATLAB isn't installed.
- [ ] **Step 3:** Wire the settings panel into the Marketplace module (a "MATLAB engine" entry in the module UI), mirroring how `modules/vault/screens/SettingsScreen.tsx` is reached from its module.
- [ ] **Step 4:** `cargo build` + typecheck. Commit: `feat(matlab): detect local MATLAB + settings`.

### Task E.2 — `matlab_run` command (sandboxed temp workspace + timeout)
**Files:** Modify `src-tauri/src/engines/matlab.rs`, `lib.rs`; Rust tests.
- [ ] **Step 1:** Write a Rust test (or a documented manual test when MATLAB is absent in CI): `matlab_run` with a trivial script returns the expected `output.json`; a script that runs past the timeout is killed and returns a `Timeout` error; a missing MATLAB returns a clear `EngineUnavailable` error.
- [ ] **Step 2:** Implement `matlab_run(script: String, inputs: serde_json::Value) -> Result<serde_json::Value, EngineError>`:
  - create a fresh temp dir; write `inputs.json` and a wrapper `.m` that loads inputs, runs the plugin's script, and writes `output.json`;
  - spawn `matlab -batch "run('wrapper.m')"` with the temp dir as cwd, a timeout (kill on expiry), and **no extra args from the plugin** (the plugin only supplies `script` content, never command-line flags);
  - read back `output.json`; clean up the temp dir; map failures to typed errors.
- [ ] **Step 3:** Tests/build green. Commit: `feat(matlab): headless matlab_run with temp-workspace isolation + timeout`.

### Task E.3 — Wire the broker handler
**Files:** Modify `apps/desktop/src/modules/marketplace/runtime/capabilityHandlers.ts`; tests.
- [ ] **Step 1:** Test: `engine.matlab.run` handler calls `invoke("matlab_run", { script, inputs })` and returns its result; an engine error rejects with a `HandlerError` carrying the message. (The broker's permission gate from A already ensures only `engine:matlab`-declaring plugins reach this handler — keep the A broker test that proves an undeclared call is rejected.)
- [ ] **Step 2:** Replace the current `throw new Error("the MATLAB bridge is not available...")` with the `invoke` call.
- [ ] **Step 3:** Tests green + typecheck. Commit: `feat(matlab): wire engine.matlab.run to the host bridge`.

### Task E.4 — Example MATLAB plugin + consent end-to-end
**Files:** Create `apps/desktop/public/plugins/matlab-demo/` (dev example, declares `engine:matlab`); docs note.
- [ ] **Step 1:** A small example that takes user inputs, calls `engine.matlab.run` with a short script, and renders the result — declaring `["engine:matlab"]`. Confirms the consent screen (C) fires and the bridge round-trips.
- [ ] **Step 2:** Update `docs/plugin-authoring/sdk-api.md` to mark `engine.matlab.run` available (remove the "NOT AVAILABLE YET" markers at lines ~136/141), and document the I/O contract + that it needs review + consent.
- [ ] **Step 3:** Add a `## [Unreleased]` "Added: MATLAB engine bridge" bullet to `CHANGELOG.md` (`scripts/check-versions.mjs` fails the release without it).
- [ ] **Step 4:** Commit: `feat(matlab): example plugin + author docs for the engine bridge`.

## Security review (do not skip)
This sub-project deliberately opens the one hole in the sandbox. Before merge:
- Confirm the plugin can pass **only** script content + JSON inputs — never executable paths, env, or flags.
- Confirm temp-workspace isolation + cleanup, the timeout actually kills the process, and concurrent runs are capped.
- Confirm a plugin without `engine:matlab` still cannot reach the handler (A broker test).
- Run `/security-review` on the diff; this is the highest-risk code in v5.

## Done when
A reviewed, consented MATLAB plugin runs a script via the local MATLAB and renders the result inside its sandbox, with the host owning detection, invocation, timeout, and cleanup — and plugins still cannot spawn processes directly.
