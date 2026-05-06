# Helios Launcher / Auto-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Helios as a native installer for macOS + Windows (signed by a Tauri ed25519 keypair, **not** OS code-signed yet), with built-in auto-update driven by GitHub Releases. Releasing a new version becomes `node scripts/bump-version.mjs <ver> && git tag v<ver> && git push --tags`; the running app picks the new version up automatically.

**Architecture:** Three-part change. (a) App-side: register `tauri-plugin-updater`, embed the ed25519 public key, add a header pill + modal that surfaces update state and triggers install/relaunch. (b) Build-side: GitHub Actions matrix that runs `tauri build` on macOS + Windows + Linux on every `v*` tag push, signs artifacts with the ed25519 private key from secrets, uploads to a draft GitHub Release, and assembles `latest.json` for the auto-updater to read. (c) Process-side: branch-and-rc workflow so nothing reaches `main` until the user has smoke-tested actual installers on a real Mac and a real Windows machine.

**Tech Stack:** `tauri-plugin-updater@2` · `@tauri-apps/plugin-updater@2` · `tauri-apps/tauri-action@v0` · GitHub Actions · Node scripts for version sync.

**Reference:** [`docs/superpowers/specs/2026-05-05-helios-launcher-design.md`](../specs/2026-05-05-helios-launcher-design.md).

---

## Process gates (READ FIRST)

The user has explicitly required:

1. **No pushes to `main`** until the launcher has been smoke-tested end-to-end with a real installer on Mac and Windows.
2. **Use a version tag** so we can revert if anything goes wrong.

Therefore the plan operates on a `launcher` branch, ships everything there first, fires the release workflow against `v2.3.0-rc.1` (a release-candidate tag, GitHub treats it as a pre-release by default), waits for the user to verify, and only **then** merges to `main` and tags `v2.3.0` proper. Task 10 is a manual gate; do not proceed past it without the user confirming.

---

## File structure

```
.github/
  workflows/
    release.yml                          # NEW: matrix build on v* tag push
apps/desktop/
  package.json                           # MODIFY: bump version, add @tauri-apps/plugin-updater
  src/
    App.tsx                              # MODIFY: mount UpdatesPill in the header, manage modal state
    components/
      UpdatesPill.tsx                    # NEW: header pill, five states (checking/up-to-date/available/downloading/offline)
      UpdateModal.tsx                    # NEW: release notes + install-and-restart
    lib/
      use-updater.ts                     # NEW: React hook wrapping the Tauri updater plugin
  src-tauri/
    Cargo.toml                           # MODIFY: add tauri-plugin-updater, bump version
    capabilities/
      default.json                       # MODIFY: add updater:default permission
    src/
      lib.rs                             # MODIFY: register updater plugin
    tauri.conf.json                      # MODIFY: bump version, add plugins.updater block
docs/
  INSTALL.md                             # NEW: first-run instructions for unsigned binaries
package.json                             # MODIFY: bump version
README.md                                # MODIFY: link to INSTALL.md
scripts/
  bump-version.mjs                       # NEW: rewrite all version fields to a target version
  check-versions.mjs                     # NEW: assert all version fields match process.env.GITHUB_REF_NAME
  __tests__/
    bump-version.test.mjs                # NEW: unit test for bump-version.mjs
```

---

## Task 0: Set up the `launcher` branch

**Files:** none (git only)

- [ ] **Step 1: Confirm clean working tree on `main`**

```bash
cd ~/Developer/helios
git status
```

Expected: "nothing to commit, working tree clean", and on branch `main`.

- [ ] **Step 2: Create + check out the `launcher` branch**

```bash
cd ~/Developer/helios
git checkout -b launcher
git push -u origin launcher
```

Expected: branch `launcher` created locally and pushed to GitHub. From now on, every commit in this plan goes on `launcher`. **Do not check out main again until Task 11.**

---

## Task 1: Generate Tauri ed25519 keypair (one-time manual step)

**Files:**
- Create (locally): `~/.tauri/helios.key`, `~/.tauri/helios.key.pub`
- Modify: `apps/desktop/src-tauri/tauri.conf.json` (add `plugins.updater.pubkey`)
- Document: README adds a "Maintainer notes" line about where the private key lives

**Note for the implementer:** the private key never enters the repo. It must be added to GitHub Actions secrets as `TAURI_SIGNING_PRIVATE_KEY` before Task 9 runs. We document the steps; the human user adds the secret manually.

- [ ] **Step 1: Generate the keypair**

```bash
cd ~/Developer/helios
mkdir -p ~/.tauri
npx --yes @tauri-apps/cli@2 signer generate -w ~/.tauri/helios.key
```

When prompted for a passphrase, **leave empty** and confirm with empty (we keep the key un-passphrased to make CI simpler; the secret already protects it). Outputs `~/.tauri/helios.key` (private) and `~/.tauri/helios.key.pub` (public, base64 string).

- [ ] **Step 2: Print the public key and capture it**

```bash
cat ~/.tauri/helios.key.pub
```

Output is a single base64 line, ~80 characters. Copy it.

- [ ] **Step 3: Print the private key (for the user to paste into GitHub Actions secret)**

```bash
cat ~/.tauri/helios.key
```

Output is a multi-line ed25519 private key. **Do not commit this anywhere.** The implementer reports back to the user: "paste the contents of `~/.tauri/helios.key` (multi-line) into a GitHub Actions secret named `TAURI_SIGNING_PRIVATE_KEY` at https://github.com/NIXELFi/helios/settings/secrets/actions before Task 9 runs."

- [ ] **Step 4: Embed the public key in `tauri.conf.json`**

Read the existing `apps/desktop/src-tauri/tauri.conf.json` (it has a `bundle` block but no `plugins` block today). Add a top-level `plugins` block with the captured pubkey. The complete added block looks like:

```json
"plugins": {
  "updater": {
    "active": true,
    "endpoints": [
      "https://github.com/NIXELFi/helios/releases/latest/download/latest.json"
    ],
    "pubkey": "<paste base64 from helios.key.pub here>"
  }
}
```

It sits at the top level alongside `app`, `bundle`, `build` — not inside any of them. Trailing commas matter; the final structure should be valid JSON.

- [ ] **Step 5: Verify Tauri config still parses**

```bash
cd ~/Developer/helios
source "$HOME/.cargo/env"
cargo check -p helios-desktop 2>&1 | tail -5
```

Expected: `Finished ... target(s) in <time>s`. No errors.

- [ ] **Step 6: Commit**

```bash
cd ~/Developer/helios
git add apps/desktop/src-tauri/tauri.conf.json
git commit -m "feat(launcher): add Tauri updater pubkey + endpoints to tauri.conf.json"
```

---

## Task 2: Wire the updater plugin into the app

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml` (add `tauri-plugin-updater`)
- Modify: `apps/desktop/src-tauri/src/lib.rs` (register plugin)
- Modify: `apps/desktop/src-tauri/capabilities/default.json` (add `updater:default`)
- Modify: `apps/desktop/package.json` (add `@tauri-apps/plugin-updater`)

- [ ] **Step 1: Add the Rust crate to Cargo.toml**

Read `apps/desktop/src-tauri/Cargo.toml`. Find the `[dependencies]` block and add `tauri-plugin-updater` underneath the existing `tauri = ...` line:

```toml
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-updater = "2"
serde = { workspace = true }
serde_json = { workspace = true }
helios-core = { path = "../../../crates/helios-core" }
helios-csv = { path = "../../../crates/helios-csv" }
helios-arrow = { path = "../../../crates/helios-arrow" }
```

(The exact surrounding lines may differ slightly — the goal is `tauri-plugin-updater = "2"` lives in `[dependencies]`. Don't touch unrelated lines.)

- [ ] **Step 2: Register the plugin in `lib.rs`**

Read `apps/desktop/src-tauri/src/lib.rs`. The current contents are:

```rust
mod commands;

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::load_csv::load_csv
        ])
        .run(tauri::generate_context!())
        .expect("error while running Helios");
}
```

Replace with:

```rust
mod commands;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::load_csv::load_csv
        ])
        .run(tauri::generate_context!())
        .expect("error while running Helios");
}
```

- [ ] **Step 3: Grant updater capability**

Read `apps/desktop/src-tauri/capabilities/default.json`. The current `permissions` array ends with `"core:path:allow-normalize"`. Append `"updater:default"`:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Default capabilities for the Helios desktop app",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:path:default",
    "core:path:allow-resolve-directory",
    "core:path:allow-resolve",
    "core:path:allow-join",
    "core:path:allow-normalize",
    "updater:default"
  ]
}
```

- [ ] **Step 4: Add the JS plugin dependency**

Read `apps/desktop/package.json`. In the `dependencies` block, add `@tauri-apps/plugin-updater`:

```json
"dependencies": {
  "@helios/lib": "workspace:*",
  "@helios/store": "workspace:*",
  "@helios/widgets": "workspace:*",
  "@tauri-apps/api": "^2.0.0",
  "@tauri-apps/plugin-updater": "^2.0.0",
  "@tauri-apps/plugin-process": "^2.0.0",
  "react": "^18.3.0",
  "react-dom": "^18.3.0",
  "zustand": "^4.5.0"
}
```

(`plugin-process` is needed for the `relaunch()` call after install.)

- [ ] **Step 5: Install + verify**

```bash
cd ~/Developer/helios
pnpm install
source "$HOME/.cargo/env"
cargo check -p helios-desktop 2>&1 | tail -5
pnpm --filter @helios/desktop typecheck 2>&1 | tail -5
```

Expected: pnpm install succeeds, `cargo check` finishes successfully, typecheck clean.

- [ ] **Step 6: Commit**

```bash
cd ~/Developer/helios
git add apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/capabilities/default.json apps/desktop/package.json pnpm-lock.yaml Cargo.lock 2>/dev/null
git add apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/capabilities/default.json apps/desktop/package.json
git commit -m "feat(launcher): register tauri-plugin-updater + grant capability"
```

---

## Task 3: Version-bump scripts + bump everything to 2.3.0

**Files:**
- Create: `scripts/bump-version.mjs`
- Create: `scripts/check-versions.mjs`
- Create: `scripts/__tests__/bump-version.test.mjs`
- Modify (output of running the script): `package.json` (root), `apps/desktop/package.json`, `apps/desktop/src-tauri/Cargo.toml`, `apps/desktop/src-tauri/tauri.conf.json`

- [ ] **Step 1: Create `scripts/bump-version.mjs`**

```js
#!/usr/bin/env node
// Usage: node scripts/bump-version.mjs 2.3.0
//
// Rewrites the version field in every source-of-truth file so they all stay in
// lockstep. Today the version drifts across four places:
//   - package.json (root)
//   - apps/desktop/package.json
//   - apps/desktop/src-tauri/Cargo.toml
//   - apps/desktop/src-tauri/tauri.conf.json
// One command updates all four. CI sanity-checks the tag against these before
// building (see check-versions.mjs).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const TARGETS = [
  { path: "package.json",                                kind: "json", field: "version" },
  { path: "apps/desktop/package.json",                   kind: "json", field: "version" },
  { path: "apps/desktop/src-tauri/tauri.conf.json",      kind: "json", field: "version" },
  { path: "apps/desktop/src-tauri/Cargo.toml",           kind: "toml-package-version" },
];

export function bumpVersion(version, root = REPO_ROOT) {
  if (!/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(version)) {
    throw new Error(`bad version "${version}" — expected semver like 2.3.0 or 2.3.0-rc.1`);
  }
  for (const t of TARGETS) {
    const fullPath = resolve(root, t.path);
    const before = readFileSync(fullPath, "utf8");
    const after = applyBump(before, t, version);
    if (before !== after) writeFileSync(fullPath, after);
  }
}

function applyBump(text, target, version) {
  if (target.kind === "json") {
    const json = JSON.parse(text);
    json[target.field] = version;
    // Preserve trailing newline + 2-space indent — matches the existing style of
    // every file in the repo. JSON.stringify drops trailing newline.
    return JSON.stringify(json, null, 2) + (text.endsWith("\n") ? "\n" : "");
  }
  if (target.kind === "toml-package-version") {
    // Match `version = "<anything>"` only inside a [package] section, not
    // inside [workspace.package] or any other table. Walk line by line.
    const lines = text.split("\n");
    let inPackage = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*\[package\]\s*$/.test(line)) inPackage = true;
      else if (/^\s*\[/.test(line)) inPackage = false;
      else if (inPackage && /^\s*version\s*=\s*"[^"]*"\s*$/.test(line)) {
        lines[i] = line.replace(/"[^"]*"/, `"${version}"`);
      }
    }
    return lines.join("\n");
  }
  throw new Error(`unknown target kind ${target.kind}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const version = process.argv[2];
  if (!version) {
    console.error("usage: node scripts/bump-version.mjs <version>");
    process.exit(2);
  }
  bumpVersion(version);
  console.log(`bumped to ${version}`);
}
```

- [ ] **Step 2: Create `scripts/check-versions.mjs`**

```js
#!/usr/bin/env node
// Usage in CI:
//   GITHUB_REF_NAME=v2.3.0 node scripts/check-versions.mjs
//
// Asserts that all four version fields equal the supplied tag (after stripping
// the leading "v"). Exits non-zero if anything mismatches.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

function readJsonVersion(rel) {
  const json = JSON.parse(readFileSync(resolve(REPO_ROOT, rel), "utf8"));
  return json.version;
}
function readCargoPackageVersion(rel) {
  const text = readFileSync(resolve(REPO_ROOT, rel), "utf8");
  const lines = text.split("\n");
  let inPackage = false;
  for (const line of lines) {
    if (/^\s*\[package\]\s*$/.test(line)) inPackage = true;
    else if (/^\s*\[/.test(line)) inPackage = false;
    else if (inPackage) {
      const m = line.match(/^\s*version\s*=\s*"([^"]*)"\s*$/);
      if (m) return m[1];
    }
  }
  throw new Error(`no [package] version in ${rel}`);
}

const tag = process.env.GITHUB_REF_NAME;
if (!tag || !/^v\d+\.\d+\.\d+(?:[-+].+)?$/.test(tag)) {
  console.error(`GITHUB_REF_NAME must be a v<semver> tag, got "${tag}"`);
  process.exit(2);
}
const expected = tag.slice(1);

const got = {
  "package.json":                            readJsonVersion("package.json"),
  "apps/desktop/package.json":               readJsonVersion("apps/desktop/package.json"),
  "apps/desktop/src-tauri/tauri.conf.json":  readJsonVersion("apps/desktop/src-tauri/tauri.conf.json"),
  "apps/desktop/src-tauri/Cargo.toml":       readCargoPackageVersion("apps/desktop/src-tauri/Cargo.toml"),
};

let ok = true;
for (const [path, version] of Object.entries(got)) {
  const match = version === expected ? "✓" : "✗";
  if (version !== expected) ok = false;
  console.log(`${match} ${path}: ${version}`);
}
if (!ok) {
  console.error(`\nVersion fields out of sync with tag ${tag} (expected ${expected}). Run \`node scripts/bump-version.mjs ${expected}\` and re-tag.`);
  process.exit(1);
}
console.log(`\nAll four fields match ${tag}.`);
```

- [ ] **Step 3: Unit test the bump script**

Create `scripts/__tests__/bump-version.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bumpVersion } from "../bump-version.mjs";

function makeRepo(initial) {
  const dir = mkdtempSync(join(tmpdir(), "helios-bump-"));
  mkdirSync(join(dir, "apps/desktop/src-tauri"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "root", version: initial.root }, null, 2) + "\n");
  writeFileSync(join(dir, "apps/desktop/package.json"), JSON.stringify({ name: "@helios/desktop", version: initial.desktop }, null, 2) + "\n");
  writeFileSync(join(dir, "apps/desktop/src-tauri/tauri.conf.json"), JSON.stringify({ productName: "Helios", version: initial.tauri }, null, 2) + "\n");
  writeFileSync(
    join(dir, "apps/desktop/src-tauri/Cargo.toml"),
    `[workspace.package]
version = "0.0.0"

[package]
name = "helios-desktop"
version = "${initial.cargo}"
edition = "2021"
`,
  );
  return dir;
}

test("bumps every file to the new version", () => {
  const dir = makeRepo({ root: "0.0.1", desktop: "0.0.1", tauri: "0.0.1", cargo: "0.0.1" });
  bumpVersion("2.3.0", dir);
  const root = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const desktop = JSON.parse(readFileSync(join(dir, "apps/desktop/package.json"), "utf8"));
  const tauri = JSON.parse(readFileSync(join(dir, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"));
  const cargo = readFileSync(join(dir, "apps/desktop/src-tauri/Cargo.toml"), "utf8");
  assert.equal(root.version, "2.3.0");
  assert.equal(desktop.version, "2.3.0");
  assert.equal(tauri.version, "2.3.0");
  assert.match(cargo, /\[package\][\s\S]*?\nversion = "2\.3\.0"/);
  // Workspace version untouched (not in [package] block).
  assert.match(cargo, /\[workspace\.package\]\nversion = "0\.0\.0"/);
});

test("rejects non-semver", () => {
  const dir = makeRepo({ root: "0.0.1", desktop: "0.0.1", tauri: "0.0.1", cargo: "0.0.1" });
  assert.throws(() => bumpVersion("not-a-version", dir), /bad version/);
});

test("accepts -rc suffixes", () => {
  const dir = makeRepo({ root: "0.0.1", desktop: "0.0.1", tauri: "0.0.1", cargo: "0.0.1" });
  bumpVersion("2.3.0-rc.1", dir);
  const root = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  assert.equal(root.version, "2.3.0-rc.1");
});
```

- [ ] **Step 4: Run the unit test**

```bash
cd ~/Developer/helios
node --test scripts/__tests__/bump-version.test.mjs
```

Expected: 3 tests pass.

- [ ] **Step 5: Bump the real repo to 2.3.0**

```bash
cd ~/Developer/helios
node scripts/bump-version.mjs 2.3.0
```

Expected stdout: `bumped to 2.3.0`. Verify by:

```bash
grep -E '"version"' package.json apps/desktop/package.json apps/desktop/src-tauri/tauri.conf.json
grep -E '^\s*version\s*=' apps/desktop/src-tauri/Cargo.toml
```

All four should now read `2.3.0`. The Cargo.toml `[workspace.package]` version stays at whatever it was (script intentionally only touches `[package]`).

- [ ] **Step 6: Commit**

```bash
cd ~/Developer/helios
git add scripts package.json apps/desktop/package.json apps/desktop/src-tauri/tauri.conf.json apps/desktop/src-tauri/Cargo.toml
git commit -m "chore: bump to 2.3.0; add bump-version + check-versions scripts"
```

---

## Task 4: useUpdater hook (Tauri-plugin wrapper)

**Files:**
- Create: `apps/desktop/src/lib/use-updater.ts`

- [ ] **Step 1: Create the hook**

```ts
import { useEffect, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/** Lifecycle of the update checker, surfaced to the UI as a discriminated
 *  union so the header pill can pattern-match. */
export type UpdaterState =
  | { kind: "checking" }
  | { kind: "up_to_date";  current: string }
  | { kind: "available";   update: UpdaterAvailable }
  | { kind: "downloading"; update: UpdaterAvailable; downloaded: number; total: number | null }
  | { kind: "installing";  update: UpdaterAvailable }
  | { kind: "offline";     error: string };

export interface UpdaterAvailable {
  version: string;
  currentVersion: string;
  notes: string | null;
  date: string | null;
  /** Tauri's Update handle; not exposed to UI. */
  _handle: Update;
}

export interface UpdaterApi {
  state: UpdaterState;
  /** Re-run the manifest check; transitions through `checking`. */
  recheck: () => void;
  /** Download + install + relaunch. Only valid when state.kind === 'available'. */
  installAndRelaunch: () => Promise<void>;
}

export function useUpdater(): UpdaterApi {
  const [state, setState] = useState<UpdaterState>({ kind: "checking" });
  // Tracks whether a check is already in flight so manual rechecks during an
  // initial check don't fire twice. Refs (not state) so toggling doesn't
  // re-render the consumer.
  const checkingRef = useRef(false);

  const runCheck = async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setState({ kind: "checking" });
    try {
      const update = await check();
      if (update) {
        setState({
          kind: "available",
          update: {
            version: update.version,
            currentVersion: update.currentVersion,
            notes: update.body ?? null,
            date: update.date ?? null,
            _handle: update,
          },
        });
      } else {
        // `check()` returns null when the app is already on the latest version.
        // We still want to surface the current version in the UI.
        const currentVersion = await getCurrentVersionSafe();
        setState({ kind: "up_to_date", current: currentVersion });
      }
    } catch (e) {
      setState({ kind: "offline", error: String(e) });
    } finally {
      checkingRef.current = false;
    }
  };

  // Auto-check ~3s after mount so the splash isn't blocked on a network call.
  useEffect(() => {
    const handle = setTimeout(runCheck, 3000);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const installAndRelaunch = async () => {
    if (state.kind !== "available") return;
    const handle = state.update._handle;
    let downloaded = 0;
    let total: number | null = null;
    setState({ kind: "downloading", update: state.update, downloaded, total });
    try {
      await handle.downloadAndInstall((event) => {
        // Tauri emits "Started" → many "Progress" → "Finished".
        if (event.event === "Started") {
          total = event.data.contentLength ?? null;
          setState({ kind: "downloading", update: state.update, downloaded, total });
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          setState({ kind: "downloading", update: state.update, downloaded, total });
        } else if (event.event === "Finished") {
          setState({ kind: "installing", update: state.update });
        }
      });
      // Once downloadAndInstall resolves the new bundle is in place; relaunch
      // exits the process and starts the new version.
      await relaunch();
    } catch (e) {
      setState({ kind: "offline", error: String(e) });
    }
  };

  return { state, recheck: runCheck, installAndRelaunch };
}

async function getCurrentVersionSafe(): Promise<string> {
  try {
    // Avoid pulling a heavyweight import — fetch the version string from the
    // Tauri-injected window.__TAURI_METADATA__ when available, fall back to
    // empty string so the UI shows a graceful "✓" without a number.
    const meta = (globalThis as unknown as { __TAURI_INTERNALS__?: { metadata?: { currentVersion?: string } } }).__TAURI_INTERNALS__;
    return meta?.metadata?.currentVersion ?? "";
  } catch { return ""; }
}
```

- [ ] **Step 2: Typecheck**

```bash
cd ~/Developer/helios
pnpm --filter @helios/desktop typecheck 2>&1 | tail -5
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
cd ~/Developer/helios
git add apps/desktop/src/lib/use-updater.ts
git commit -m "feat(launcher): useUpdater hook wrapping the Tauri updater plugin"
```

---

## Task 5: UpdatesPill component

**Files:**
- Create: `apps/desktop/src/components/UpdatesPill.tsx`

- [ ] **Step 1: Create the component**

```tsx
import type { UpdaterState } from "../lib/use-updater";

interface Props {
  state: UpdaterState;
  onClick: () => void;
}

/** Header pill that surfaces the updater lifecycle. Always visible — even
 *  the up-to-date state shows a dim "✓" pill, both as a manual-recheck
 *  affordance and to make it visible to the user that the app is checking
 *  for updates at all. */
export function UpdatesPill({ state, onClick }: Props) {
  const view = pillFor(state);
  return (
    <button
      onClick={onClick}
      className={
        "px-2 py-0.5 text-xs border rounded-sm cursor-pointer transition-colors flex items-center gap-1 " +
        view.className
      }
      title={view.title}
    >
      {view.label}
    </button>
  );
}

function pillFor(state: UpdaterState): { label: string; title: string; className: string } {
  switch (state.kind) {
    case "checking":
      return {
        label: "checking…",
        title: "Checking for updates",
        className: "bg-[#16171B] text-[#7B8088] border-[#2A2C32]",
      };
    case "up_to_date":
      return {
        label: `✓ v${state.current || "—"}`,
        title: "You're on the latest version. Click to recheck.",
        className: "bg-[#16171B] text-[#7B8088] border-[#2A2C32] hover:border-[#FFC627]",
      };
    case "available":
      return {
        label: `↑ v${state.update.version} ready`,
        title: `Update available (you're on v${state.update.currentVersion})`,
        className: "bg-[#FFC627] text-[#0E0E10] border-[#FFC627] font-semibold animate-pulse",
      };
    case "downloading": {
      const pct = state.total ? Math.min(100, Math.round((state.downloaded / state.total) * 100)) : null;
      return {
        label: pct === null ? "downloading…" : `downloading ${pct}%`,
        title: "Downloading update",
        className: "bg-[#FFC627] text-[#0E0E10] border-[#FFC627]",
      };
    }
    case "installing":
      return {
        label: "installing…",
        title: "Installing update; the app will relaunch",
        className: "bg-[#FFC627] text-[#0E0E10] border-[#FFC627]",
      };
    case "offline":
      return {
        label: "– offline",
        title: `Update check failed: ${state.error}. Click to retry.`,
        className: "bg-[#16171B] text-[#7B8088] border-[#2A2C32] hover:border-[#FFC627]",
      };
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
cd ~/Developer/helios
pnpm --filter @helios/desktop typecheck 2>&1 | tail -5
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
cd ~/Developer/helios
git add apps/desktop/src/components/UpdatesPill.tsx
git commit -m "feat(launcher): UpdatesPill header indicator with five lifecycle states"
```

---

## Task 6: UpdateModal component

**Files:**
- Create: `apps/desktop/src/components/UpdateModal.tsx`

- [ ] **Step 1: Create the modal**

```tsx
import type { UpdaterAvailable, UpdaterState } from "../lib/use-updater";

interface Props {
  state: UpdaterState;
  /** Used to disable "Install and restart" mid-playback. App passes
   *  `playback.playing === true`; null when no session loaded. */
  playbackBlocked: boolean;
  onInstall: () => void;
  onClose: () => void;
}

export function UpdateModal({ state, playbackBlocked, onInstall, onClose }: Props) {
  if (state.kind !== "available" && state.kind !== "downloading" && state.kind !== "installing") {
    return null;
  }

  const update = state.kind === "available" ? state.update
              : state.kind === "downloading" ? state.update
              : state.update;

  const downloading = state.kind === "downloading";
  const installing  = state.kind === "installing";
  const inFlight    = downloading || installing;

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-[#0E0E10] border border-[#2A2C32] w-[560px] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-9 flex items-center justify-between px-3 border-b border-[#2A2C32]">
          <span className="text-xs uppercase tracking-wider text-[#FFC627]">Update available</span>
          <button
            aria-label="Close"
            onClick={onClose}
            className="w-5 h-5 flex items-center justify-center text-[#7B8088] hover:text-[#FFC627] hover:bg-[#16171B] rounded-sm"
          >×</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <div className="text-sm">
            <span className="text-[#D8DCE2] font-semibold">Helios v{update.version}</span>
            <span className="text-[#7B8088]"> — you're on v{update.currentVersion}</span>
          </div>
          {update.date && (
            <div className="text-xs text-[#5A5F66] mt-0.5">Released {update.date}</div>
          )}
          <pre className="mt-4 whitespace-pre-wrap font-sans text-xs text-[#D8DCE2] bg-[#16171B] border border-[#2A2C32] p-2 rounded-sm overflow-auto max-h-64">
{update.notes || "(no release notes)"}
          </pre>
          {downloading && (
            <DownloadProgressBar
              downloaded={(state as Extract<UpdaterState, { kind: "downloading" }>).downloaded}
              total={(state as Extract<UpdaterState, { kind: "downloading" }>).total}
            />
          )}
          {installing && (
            <div className="mt-3 text-xs text-[#7B8088]">Installing… the app will relaunch automatically.</div>
          )}
          {playbackBlocked && !inFlight && (
            <div className="mt-3 text-xs text-[#FFB800]">
              Pause playback before installing — the app will restart and lose your scrub position.
            </div>
          )}
        </div>
        <div className="h-12 flex items-center justify-end gap-2 px-3 border-t border-[#2A2C32]">
          <button
            onClick={onClose}
            disabled={inFlight}
            className="px-2 py-1 text-xs border border-[#2A2C32] bg-[#16171B] text-[#7B8088] hover:border-[#FFC627] rounded-sm cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >Remind me later</button>
          <button
            onClick={onInstall}
            disabled={inFlight || playbackBlocked}
            className="px-3 py-1 text-xs bg-[#FFC627] text-[#0E0E10] hover:bg-[#FFD24A] rounded-sm cursor-pointer font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
          >Install and restart</button>
        </div>
      </div>
    </div>
  );
}

function DownloadProgressBar({ downloaded, total }: { downloaded: number; total: number | null }) {
  const pct = total ? Math.min(100, Math.round((downloaded / total) * 100)) : null;
  return (
    <div className="mt-3">
      <div className="h-1.5 bg-[#2A2C32] rounded-sm overflow-hidden">
        <div
          className="h-full bg-[#FFC627] transition-all duration-150"
          style={{ width: pct === null ? "100%" : `${pct}%` }}
        />
      </div>
      <div className="mt-1 text-[10px] text-[#7B8088] font-mono-num">
        {pct === null ? "(unknown size)" : `${pct}% · ${formatBytes(downloaded)}${total ? ` / ${formatBytes(total)}` : ""}`}
      </div>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
```

- [ ] **Step 2: Typecheck**

```bash
cd ~/Developer/helios
pnpm --filter @helios/desktop typecheck 2>&1 | tail -5
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
cd ~/Developer/helios
git add apps/desktop/src/components/UpdateModal.tsx
git commit -m "feat(launcher): UpdateModal with release notes + install-and-relaunch"
```

---

## Task 7: Wire the pill + modal into App.tsx

**Files:**
- Modify: `apps/desktop/src/App.tsx`

- [ ] **Step 1: Add the imports + hook to App.tsx**

Read `apps/desktop/src/App.tsx`. Near the existing imports (top of file), add:

```tsx
import { useUpdater } from "./lib/use-updater";
import { UpdatesPill } from "./components/UpdatesPill";
import { UpdateModal } from "./components/UpdateModal";
```

Inside the `App()` component body, near the other top-level state (`useState` calls), add:

```tsx
const updater = useUpdater();
const [updateModalOpen, setUpdateModalOpen] = useState(false);
```

- [ ] **Step 2: Auto-open the modal when an update first becomes available**

Add this `useEffect` near the other effects in `App()`:

```tsx
// When the updater transitions into "available" (after the auto-check on
// launch), auto-open the modal once. The user can dismiss with "Remind me
// later"; we don't auto-reopen on every state change to avoid being annoying.
useEffect(() => {
  if (updater.state.kind === "available") setUpdateModalOpen(true);
}, [updater.state.kind]);
```

- [ ] **Step 3: Mount the pill in the header**

In the existing header JSX, find the line that currently renders the cursor clock:

```tsx
<span className="font-mono-num"><CursorClock emitter={emitter} /></span>
```

Replace with two siblings — pill first, then clock:

```tsx
<UpdatesPill
  state={updater.state}
  onClick={() => {
    if (updater.state.kind === "up_to_date" || updater.state.kind === "offline") {
      updater.recheck();
    } else if (updater.state.kind === "available" || updater.state.kind === "downloading" || updater.state.kind === "installing") {
      setUpdateModalOpen(true);
    }
  }}
/>
<span className="font-mono-num"><CursorClock emitter={emitter} /></span>
```

- [ ] **Step 4: Render the modal at the bottom of the App tree**

Find the closing `</div>` of the outer App container, near the existing modal renders for `channelsOpen`, `addTileOpen`, `mathChannelsOpen`. Add a sibling:

```tsx
{updateModalOpen && (
  <UpdateModal
    state={updater.state}
    playbackBlocked={false}
    onInstall={() => updater.installAndRelaunch()}
    onClose={() => setUpdateModalOpen(false)}
  />
)}
```

(`playbackBlocked` is `false` for now because the v2.2 codebase doesn't yet expose a `playback.playing` boolean to App; the field is wired but always `false`. When the playback state moves into a context that App can read, flip this to that boolean. This is intentionally a known no-op placeholder — see also Task 7 step 6 below for the small follow-up to wire it.)

- [ ] **Step 5: Typecheck**

```bash
cd ~/Developer/helios
pnpm --filter @helios/desktop typecheck 2>&1 | tail -5
```

Expected: clean.

- [ ] **Step 6: Lift `PlaybackControls` `playing` state into App**

PlaybackControls today owns its `playing` state internally (via `useState`). Lift it into App so we can pass it to UpdateModal as `playbackBlocked`:

Replace this near the top of `App()`:

```tsx
const updater = useUpdater();
const [updateModalOpen, setUpdateModalOpen] = useState(false);
```

with:

```tsx
const updater = useUpdater();
const [updateModalOpen, setUpdateModalOpen] = useState(false);
const [playing, setPlaying] = useState(false);
```

Update the `<PlaybackControls />` invocation in the header to pass these props:

```tsx
<PlaybackControls emitter={emitter} ext={ext} playing={playing} onPlayingChange={setPlaying} />
```

Update the `PlaybackControls` component signature (further down the file) from:

```tsx
function PlaybackControls({
  emitter, ext,
}: {
  emitter: CursorEmitter;
  ext: { startUs: number; endUs: number };
}) {
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(1);
```

to:

```tsx
function PlaybackControls({
  emitter, ext, playing, onPlayingChange,
}: {
  emitter: CursorEmitter;
  ext: { startUs: number; endUs: number };
  playing: boolean;
  onPlayingChange: (p: boolean) => void;
}) {
  const [speed, setSpeed] = useState<number>(1);
  const setPlaying = onPlayingChange;
```

Update the UpdateModal render to use `playing`:

```tsx
{updateModalOpen && (
  <UpdateModal
    state={updater.state}
    playbackBlocked={playing}
    onInstall={() => updater.installAndRelaunch()}
    onClose={() => setUpdateModalOpen(false)}
  />
)}
```

- [ ] **Step 7: Typecheck again**

```bash
cd ~/Developer/helios
pnpm --filter @helios/desktop typecheck 2>&1 | tail -5
```

Expected: clean.

- [ ] **Step 8: Commit**

```bash
cd ~/Developer/helios
git add apps/desktop/src/App.tsx
git commit -m "feat(launcher): mount UpdatesPill + UpdateModal; lift playing state"
```

---

## Task 8: docs/INSTALL.md + README link

**Files:**
- Create: `docs/INSTALL.md`
- Modify: `README.md` (link to INSTALL.md)

- [ ] **Step 1: Create `docs/INSTALL.md`**

```markdown
# Installing Helios

Helios ships as a native desktop app for macOS and Windows. Auto-updates run inside the app once installed; you only need this guide for the very first install.

## macOS

1. Download `Helios_<version>_universal.dmg` from the [latest release](https://github.com/NIXELFi/helios/releases/latest).
2. Open the `.dmg` and drag `Helios.app` into `/Applications`.
3. **The first time you launch Helios, macOS will say "Helios can't be opened because it is from an unidentified developer."** This is expected — we don't have an Apple Developer ID code-signing cert yet. Do this once:
   - In Finder, navigate to `/Applications`.
   - Right-click (or Control-click) `Helios.app` → **Open**.
   - macOS shows a softer dialog: "macOS cannot verify the developer of 'Helios'. Are you sure you want to open it?" Click **Open**.
   - macOS remembers this exception forever for this app.

(Power-user alternative: `xattr -d com.apple.quarantine /Applications/Helios.app` clears the quarantine bit; double-clicking afterwards launches normally.)

## Windows

1. Download `Helios_<version>_x64-setup.exe` from the [latest release](https://github.com/NIXELFi/helios/releases/latest).
2. Run the installer.
3. **Windows SmartScreen will say "Windows protected your PC."** Same reason — no Authenticode signing cert yet. Do this once:
   - Click **More info**.
   - Click **Run anyway**.
   - The installer proceeds normally.

The `.msi` variant (`Helios_<version>_x64_en-US.msi`) works the same way, with a slightly different SmartScreen dialog.

## Linux

Linux builds (`Helios_<version>_amd64.AppImage`) ship in every release as a convenience. **Auto-update is not wired for Linux** — to upgrade, download the new AppImage and replace your local copy.

```bash
chmod +x Helios_<version>_amd64.AppImage
./Helios_<version>_amd64.AppImage
```

## Updates after first install

Once Helios is installed, the **Updates** pill in the top-right of the header surfaces update state. Click it when a new version is ready, review the release notes in the modal, and click **Install and restart**. The OS scary-warnings shown above only happen on first install — auto-updates verify a Tauri-signed bundle inside the running app, so they bypass Gatekeeper / SmartScreen.

## Troubleshooting

- **"Updates" pill says "offline"** — your machine can't reach `github.com`. Auto-update isn't required for the app to function; click the pill to retry whenever connectivity comes back, or just download a new installer manually.
- **Update modal says signature failed** — never click through this. Download the latest installer from GitHub Releases manually and reinstall. (If this happens repeatedly, our private signing key may have leaked; tell a maintainer.)
```

- [ ] **Step 2: Add a link in README**

Read `README.md`. Find the existing `## Quick start` section near the top:

```markdown
## Quick start

```bash
pnpm install
pnpm dev
```

The dev command runs Vite + the Tauri shell, opens a window, and seeds three bundled CSVs into the Sessions panel.
```

Add a sibling section right after it:

```markdown
## Installing a release build

If you don't need to develop — you just want to use Helios — see [`docs/INSTALL.md`](docs/INSTALL.md). It covers downloading the latest installer for macOS / Windows / Linux and the one-time first-run instructions for our (currently un-OS-signed) installers.
```

- [ ] **Step 3: Commit**

```bash
cd ~/Developer/helios
git add docs/INSTALL.md README.md
git commit -m "docs: INSTALL.md with first-run unsigned-binary instructions"
```

---

## Task 9: GitHub Actions release workflow

**Files:**
- Create: `.github/workflows/release.yml`

**Manual user action required before this task is meaningful:** the `TAURI_SIGNING_PRIVATE_KEY` secret must already be set on the repo (see Task 1 step 3). The implementer can land the workflow regardless; it just won't sign properly until the secret exists.

- [ ] **Step 1: Create the workflow file**

```yaml
name: Release

on:
  push:
    tags:
      - "v*"
  workflow_dispatch:
    inputs:
      tag:
        description: "Version tag (e.g. v2.3.0-rc.1)"
        required: true

concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false

permissions:
  contents: write

jobs:
  build:
    name: Build (${{ matrix.platform }})
    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: macos
            runner: macos-14
            tauri-args: "--target universal-apple-darwin"
          - platform: windows
            runner: windows-latest
            tauri-args: ""
          - platform: linux
            runner: ubuntu-22.04
            tauri-args: ""

    runs-on: ${{ matrix.runner }}
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Determine version tag
        id: version
        shell: bash
        run: |
          if [ "${{ github.event_name }}" = "workflow_dispatch" ]; then
            echo "tag=${{ inputs.tag }}" >> "$GITHUB_OUTPUT"
          else
            echo "tag=${GITHUB_REF_NAME}" >> "$GITHUB_OUTPUT"
          fi

      - name: Set up Node 20
        uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Set up pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 9

      - name: Set up Rust stable
        uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.platform == 'macos' && 'aarch64-apple-darwin,x86_64-apple-darwin' || '' }}

      - name: Cache cargo
        uses: Swatinem/rust-cache@v2
        with:
          workspaces: |
            apps/desktop/src-tauri
            crates/helios-core
            crates/helios-csv
            crates/helios-arrow

      - name: Linux dependencies
        if: matrix.platform == 'linux'
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libsoup-3.0-dev

      - name: Install JS deps
        run: pnpm install --frozen-lockfile

      - name: Verify versions match the tag
        env:
          GITHUB_REF_NAME: ${{ steps.version.outputs.tag }}
        run: node scripts/check-versions.mjs

      - name: Run Rust tests
        run: cargo test --workspace

      - name: Run TS tests
        run: pnpm -r --workspace-concurrency=1 test

      - name: Build + sign + upload
        uses: tauri-apps/tauri-action@v0
        env:
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        with:
          tagName: ${{ steps.version.outputs.tag }}
          releaseName: "Helios ${{ steps.version.outputs.tag }}"
          releaseBody: |
            See [v2_changes/](https://github.com/NIXELFi/helios/tree/${{ steps.version.outputs.tag }}/v2_changes/) for the running log.
            First-install instructions: [docs/INSTALL.md](https://github.com/NIXELFi/helios/blob/${{ steps.version.outputs.tag }}/docs/INSTALL.md).
          releaseDraft: true
          prerelease: ${{ contains(steps.version.outputs.tag, '-') }}
          projectPath: apps/desktop
          args: ${{ matrix.tauri-args }}
          updaterJsonPreferNsis: true

  publish:
    name: Publish release
    needs: build
    runs-on: ubuntu-latest
    if: ${{ !contains(github.ref_name, '-') }}
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Promote draft release to published
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: gh release edit "${GITHUB_REF_NAME}" --draft=false
```

Notes baked into the workflow:

- **Tag prefix `v` + semver** triggers builds. `workflow_dispatch` lets us run a dry build with an explicit tag input.
- **Pre-releases** (tags containing `-`, e.g. `v2.3.0-rc.1`) are marked as pre-releases and **kept as drafts** — the `publish` job runs only on stable tags. This keeps `-rc.1` invisible from the auto-updater (which only reads the latest non-prerelease) until we promote it.
- `tauri-action` produces the per-platform `.sig` files and the `latest.json` automatically when given the signing env vars and `updaterJsonPreferNsis: true` (Windows uses NSIS for the updater payload, MSI just for first install).

- [ ] **Step 2: Push the branch (NOT main) and the workflow file**

```bash
cd ~/Developer/helios
git add .github/workflows/release.yml
git commit -m "ci: release workflow — matrix tauri-action build on v* tags"
git push origin launcher
```

Expected: pushes the `launcher` branch with all preceding commits + this workflow.

---

## Task 10: Smoke test gate (manual user action — DO NOT proceed past this without user confirmation)

This task is **not** a task an implementer can mechanically complete. The user must do it on real Mac and Windows machines.

- [ ] **Step 1: User confirms the Tauri private key secret is set**

Visit https://github.com/NIXELFi/helios/settings/secrets/actions and confirm `TAURI_SIGNING_PRIVATE_KEY` exists. (If not, paste in the contents of `~/.tauri/helios.key` from Task 1 step 3.)

- [ ] **Step 2: Push a release-candidate tag**

```bash
cd ~/Developer/helios
# Make sure we're on launcher and the bumped version is 2.3.0
git checkout launcher
node scripts/bump-version.mjs 2.3.0-rc.1
git commit -am "chore: bump to 2.3.0-rc.1 for smoke test"
git push origin launcher
git tag v2.3.0-rc.1
git push origin v2.3.0-rc.1
```

Watch the workflow at https://github.com/NIXELFi/helios/actions. It should produce a draft pre-release tagged `v2.3.0-rc.1`.

- [ ] **Step 3: macOS smoke test**

On a Mac that hasn't run Helios:
1. Download `Helios_2.3.0-rc.1_universal.dmg` from the draft release.
2. Open the `.dmg`, drag to /Applications.
3. Right-click `Helios.app` → Open. Confirm the "unidentified developer" workaround works as documented.
4. Confirm the app launches and the **Updates** pill in the header reads `✓ v2.3.0-rc.1` (or `checking…` then `✓ v2.3.0-rc.1`).
5. Click the pill. Toast says "you're on the latest version" (or similar — Tauri returns null when current = latest, which our `useUpdater` translates to `up_to_date`).

- [ ] **Step 4: Windows smoke test**

On a Windows machine:
1. Download `Helios_2.3.0-rc.1_x64-setup.exe`.
2. Run; click through SmartScreen "More info → Run anyway".
3. Same checks: app launches, Updates pill shows up-to-date, manual recheck works.

- [ ] **Step 5: Update flow smoke test**

Push a higher RC to verify the auto-update path:

```bash
cd ~/Developer/helios
node scripts/bump-version.mjs 2.3.0-rc.2
git commit -am "chore: bump to 2.3.0-rc.2 for update smoke test"
git push origin launcher
git tag v2.3.0-rc.2
git push origin v2.3.0-rc.2
```

Wait for the workflow to produce a `v2.3.0-rc.2` draft pre-release, then **manually publish it** via the GitHub UI (since the publish job only runs on stable tags). On the running rc.1 install, click the Updates pill (or relaunch and wait 3s for the auto-check). Modal should appear claiming v2.3.0-rc.2 is available. Click "Install and restart". App downloads, replaces itself, relaunches. Header now reads `✓ v2.3.0-rc.2`.

If any step fails, **stop here**. Do not proceed to Task 11. Diagnose, fix the issue on `launcher`, push another rc tag.

- [ ] **Step 6: User explicitly approves merging to main**

This step is the gate. The implementer must wait for the user to say "approved, proceed to Task 11" or equivalent. **Do not auto-proceed.**

---

## Task 11: Merge to main + tag v2.3.0 stable

**Only run after Task 10 step 6 explicit approval.**

- [ ] **Step 1: Bump to clean 2.3.0 (off any -rc suffix)**

```bash
cd ~/Developer/helios
git checkout launcher
node scripts/bump-version.mjs 2.3.0
git commit -am "chore: bump to 2.3.0 for stable release"
git push origin launcher
```

- [ ] **Step 2: Merge `launcher` into `main`**

```bash
cd ~/Developer/helios
git checkout main
git pull origin main
git merge --no-ff launcher -m "Merge branch 'launcher': v2.3 launcher + auto-update"
git push origin main
```

- [ ] **Step 3: Tag and push v2.3.0**

```bash
cd ~/Developer/helios
git tag -a v2.3.0 -m "Helios v2.3.0

Launcher / auto-update release. See docs/INSTALL.md for first-install
instructions, and the Updates pill in the header for in-app upgrades."
git push origin v2.3.0
```

The release workflow runs against the tag, produces a draft (then promotes to published since v2.3.0 has no `-` suffix), and the `latest.json` at `https://github.com/NIXELFi/helios/releases/latest/download/latest.json` now points at v2.3.0.

- [ ] **Step 4: Watch the workflow finish**

Visit https://github.com/NIXELFi/helios/actions and confirm:
1. `build` matrix succeeds on all three runners.
2. `publish` job runs and promotes the draft to published.

- [ ] **Step 5: Sanity-check the published release**

```bash
curl -L https://github.com/NIXELFi/helios/releases/latest/download/latest.json | jq .version
```

Expected: `"2.3.0"`.

- [ ] **Step 6: Delete RC tags + their pre-releases (optional cleanup)**

The `gh release delete --cleanup-tag` flag removes both the GitHub Release and its underlying git tag in one shot:

```bash
cd ~/Developer/helios
gh release delete v2.3.0-rc.1 --yes --cleanup-tag || true
gh release delete v2.3.0-rc.2 --yes --cleanup-tag || true
git tag -d v2.3.0-rc.1 v2.3.0-rc.2 2>/dev/null || true
git fetch --prune --prune-tags origin
```

Final two lines remove any local-only tag remnants and re-sync the local view of remote tags.

- [ ] **Step 7: Done.** Email/Slack the team with the GitHub Releases URL and a pointer at `docs/INSTALL.md`. From here, every future `v*` tag pushed to `main` is an auto-update for everyone running Helios.
