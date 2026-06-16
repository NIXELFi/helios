#!/usr/bin/env node
// Usage in CI:
//   GITHUB_REF_NAME=v2.3.0 node scripts/check-versions.mjs
//
// Asserts that all four version fields equal the supplied tag (after stripping
// the leading "v"). Exits non-zero if anything mismatches.
//
// Scope (by design): this script only checks the four user-facing release
// version fields — the root package.json, apps/desktop/package.json,
// apps/desktop/src-tauri/tauri.conf.json, and the Cargo workspace.package
// version in Cargo.toml. Internal packages under `packages/*` and `infra/*`
// are intentionally NOT checked: they are independently versioned (e.g.
// @helios/ui stays at 0.0.x while the desktop app advances), and forcing
// them in lockstep with the release tag would create noisy bumps on
// every release. If you add a new top-level release artifact, add it
// here; do not auto-include `packages/*`.
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

// Changelog gate — the GitHub release body + the Slack notification are sourced
// from CHANGELOG.md (see scripts/extract-changelog.mjs and the publish job in
// .github/workflows/release.yml), so a tagged release MUST carry a section for
// its version. This is what makes "add your changelog" non-optional: forget it
// and the release fails right here.
let changelogOk = false;
try {
  const changelog = readFileSync(resolve(REPO_ROOT, "CHANGELOG.md"), "utf8");
  const esc = expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  changelogOk = new RegExp(`^##\\s*\\[${esc}\\]`, "m").test(changelog);
} catch {
  /* missing file counts as not-ok */
}
console.log(`${changelogOk ? "✓" : "✗"} CHANGELOG.md: section for ${expected}`);
if (!changelogOk) ok = false;

if (!ok) {
  console.error(
    `\nRelease preflight failed for tag ${tag}:\n` +
      `  - all version fields must equal ${expected}\n` +
      `  - CHANGELOG.md must have a "## [${expected}]" section\n` +
      `Fix both by adding your notes under [Unreleased], then run \`node scripts/bump-version.mjs ${expected}\` and re-tag.`,
  );
  process.exit(1);
}
console.log(`\nAll version fields + the CHANGELOG.md section match ${tag}.`);
