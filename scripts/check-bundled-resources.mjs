#!/usr/bin/env node
// Usage in CI (and locally):
//   node scripts/check-bundled-resources.mjs
//
// WHY THIS EXISTS
// ---------------
// The release build (tauri-action -> `tauri build`) does NOT compile the C#
// binaries. There is no SOLIDWORKS and no `dotnet build` on the GitHub runner.
// The SOLIDWORKS add-in (HeliosVault.dll), the Explorer shell extension
// (HeliosShell.dll + SharpShell.dll), and the add-in-free read-only helper
// (HeliosSwReadonly.exe) are PRE-BUILT on a dev machine (`pnpm -C apps/desktop
// build:win`, or the individual build:addin / build:shell / build:swhelper
// scripts) and COMMITTED into apps/desktop/src-tauri/resources/. `tauri build`
// then embeds whatever is committed there into the installer.
//
// Failure mode this guards against: someone edits the C# source, forgets to
// rebuild + commit the DLL, and a STALE or MISSING binary ships silently.
// `tauri build` already errors on a *missing* declared resource, but this check
// fails earlier and louder, and prints each binary's size + sha256 into the
// release log so the shipped bytes are auditable. (It cannot detect "stale but
// present" on its own — that's a process step: rebuild + commit before tagging.
// Each C# DLL also stamps the source git short-hash into its ProductVersion, so
// you can eyeball which source state a shipped DLL was built from.)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const TAURI_DIR = resolve(REPO_ROOT, "apps/desktop/src-tauri");
const CONF = resolve(TAURI_DIR, "tauri.conf.json");

const conf = JSON.parse(readFileSync(CONF, "utf8"));
const resources = conf?.bundle?.resources ?? {};
const sources = Array.isArray(resources) ? resources : Object.keys(resources);

if (sources.length === 0) {
  console.error("No bundle.resources declared in tauri.conf.json — unexpected.");
  process.exit(2);
}

// The committed prebuilt binaries that CI never regenerates. Missing/empty here
// is a release blocker; everything else (yaml/json configs) just needs to exist.
const BINARY = /\.(dll|exe)$/i;

let ok = true;
const missing = [];
for (const src of sources) {
  const abs = resolve(TAURI_DIR, src);
  let size = -1;
  try {
    size = statSync(abs).size;
  } catch {
    size = -1;
  }
  const isBin = BINARY.test(src);
  if (size <= 0) {
    ok = false;
    missing.push(src);
    console.log(`✗ ${src}: ${size < 0 ? "MISSING" : "EMPTY"}`);
    continue;
  }
  if (isBin) {
    const sha = createHash("sha256").update(readFileSync(abs)).digest("hex");
    console.log(`✓ ${src}: ${size} bytes  sha256=${sha.slice(0, 16)}`);
  } else {
    console.log(`✓ ${src}: ${size} bytes`);
  }
}

// The reverse direction for CFD example configs: every config committed under
// resources/cfd/configs/ must be declared, or cfd_list_examples (which skips
// files that don't exist) silently drops it from installed builds while dev
// builds still show it.
const CFD_DIR = "resources/cfd/configs";
const declared = new Set(sources.map((s) => s.replace(/\\/g, "/")));
const undeclared = readdirSync(resolve(TAURI_DIR, CFD_DIR))
  .filter((f) => f.endsWith(".json"))
  .map((f) => `${CFD_DIR}/${f}`)
  .filter((f) => !declared.has(f));
for (const f of undeclared) {
  console.log(`✗ ${f}: committed but not declared in bundle.resources`);
}
if (undeclared.length > 0) {
  console.error(
    `\n${undeclared.length} CFD example config(s) not bundled: ${undeclared.join(", ")}\n` +
      `Add each one to bundle.resources in apps/desktop/src-tauri/tauri.conf.json.`,
  );
  process.exit(1);
}

if (!ok) {
  console.error(
    `\n${missing.length} bundled resource(s) missing or empty: ${missing.join(", ")}\n` +
      `These are NOT rebuilt by CI. Rebuild the C# binaries and commit resources/:\n` +
      `  pnpm -C apps/desktop build:win    (or build:addin / build:shell / build:swhelper)\n` +
      `then re-commit apps/desktop/src-tauri/resources/ before tagging a release.`,
  );
  process.exit(1);
}
console.log(`\nAll ${sources.length} bundled resources present and non-empty.`);
