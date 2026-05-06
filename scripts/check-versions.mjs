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

function readWorkspacePackageVersion(rel) {
  const text = readFileSync(resolve(REPO_ROOT, rel), "utf8");
  const lines = text.split("\n");
  let inWorkspacePackage = false;
  for (const line of lines) {
    if (/^\s*\[workspace\.package\]\s*$/.test(line)) inWorkspacePackage = true;
    else if (/^\s*\[/.test(line)) inWorkspacePackage = false;
    else if (inWorkspacePackage) {
      const m = line.match(/^\s*version\s*=\s*"([^"]*)"\s*$/);
      if (m) return m[1];
    }
  }
  throw new Error(`no [workspace.package] version in ${rel}`);
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
  "Cargo.toml":                              readWorkspacePackageVersion("Cargo.toml"),
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
