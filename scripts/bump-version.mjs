#!/usr/bin/env node
// Usage: node scripts/bump-version.mjs 2.3.0
//
// Rewrites the version field in every source-of-truth file so they all stay in
// lockstep. Today the version drifts across four places:
//   - package.json (root)
//   - apps/desktop/package.json
//   - apps/desktop/src-tauri/tauri.conf.json
//   - apps/desktop/src-tauri/Cargo.toml
// One command updates all four. CI sanity-checks the tag against these before
// building (see check-versions.mjs).
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { hasEntries, headingRegex, sectionBody } from "./changelog-section.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const TARGETS = [
  { path: "package.json",                                kind: "json", field: "version" },
  { path: "apps/desktop/package.json",                   kind: "json", field: "version" },
  { path: "apps/desktop/src-tauri/tauri.conf.json",      kind: "json", field: "version" },
  { path: "Cargo.toml",                                  kind: "toml-workspace-version" },
];

export function bumpVersion(version, root = REPO_ROOT) {
  if (!/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(version)) {
    throw new Error(`bad version "${version}" — expected semver like 2.3.0 or 2.3.0-rc.1`);
  }
  // Check the changelog BEFORE touching any file, so a refusal leaves the repo
  // unmodified rather than half-bumped.
  assertChangelogPromotable(version, root);
  for (const t of TARGETS) {
    const fullPath = resolve(root, t.path);
    const before = readFileSync(fullPath, "utf8");
    const after = applyBump(before, t, version);
    if (before !== after) writeFileSync(fullPath, after);
  }
  return promoteChangelog(version, root);
}

// Promote CHANGELOG.md's [Unreleased] section to a dated `## [version]` section,
// leaving a fresh empty [Unreleased] on top. This is what feeds the release body
// + Slack (extract-changelog.mjs / release.yml) and satisfies the changelog gate
// in check-versions.mjs. Idempotent: a no-op if a section for this version
// already exists, if there's no CHANGELOG.md, or if there's no [Unreleased]
// heading. Returns true when it rewrote the file.
//
// THROWS when [Unreleased] exists but is empty: promoting it would mint a
// version section with no notes, which then sails past the release gate and
// ships a GitHub release + Slack post saying nothing. Better to stop the bump
// here, where the developer can still write the entries.
export function promoteChangelog(version, root = REPO_ROOT, today = new Date().toISOString().slice(0, 10)) {
  const path = resolve(root, "CHANGELOG.md");
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  if (headingRegex(version, "m").test(text)) return false; // already promoted
  assertChangelogPromotable(version, root, text);
  const after = text.replace(/^(##\s*\[Unreleased\][^\n]*)\n/m, `$1\n\n## [${version}] - ${today}\n`);
  if (after === text) return false; // no [Unreleased] heading to promote
  writeFileSync(path, after);
  return true;
}

// Throw unless CHANGELOG.md's [Unreleased] section is safe to promote. Silent
// (returns) when there's no CHANGELOG.md, no [Unreleased] heading, or a section
// for `version` already exists — those are the documented no-op cases.
export function assertChangelogPromotable(version, root = REPO_ROOT, preloaded = null) {
  let text = preloaded;
  if (text === null) {
    try {
      text = readFileSync(resolve(root, "CHANGELOG.md"), "utf8");
    } catch {
      return;
    }
  }
  if (headingRegex(version, "m").test(text)) return; // already promoted
  const unreleased = sectionBody(text, "Unreleased");
  if (unreleased === null || hasEntries(unreleased)) return;
  throw new Error(
    `CHANGELOG.md's [Unreleased] section is empty — refusing to promote it to [${version}].\n` +
      `The release body and the Slack post are generated from this section, so an empty\n` +
      `promotion ships a release with no notes. Add your entries under [Unreleased]\n` +
      `(### Added / Changed / Fixed / …, one "- " bullet per user-facing change), then re-run.`,
  );
}

function applyBump(text, target, version) {
  if (target.kind === "json") {
    const json = JSON.parse(text);
    json[target.field] = version;
    // Preserve trailing newline + 2-space indent — matches the existing style of
    // every file in the repo. JSON.stringify drops trailing newline.
    return JSON.stringify(json, null, 2) + (text.endsWith("\n") ? "\n" : "");
  }
  if (target.kind === "toml-workspace-version") {
    // Match `version = "<anything>"` inside [workspace.package] section.
    const lines = text.split("\n");
    let inWorkspacePackage = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*\[workspace\.package\]\s*$/.test(line)) inWorkspacePackage = true;
      else if (/^\s*\[/.test(line)) inWorkspacePackage = false;
      else if (inWorkspacePackage && /^\s*version\s*=\s*"[^"]*"\s*$/.test(line)) {
        lines[i] = line.replace(/"[^"]*"/, `"${version}"`);
      }
    }
    return lines.join("\n");
  }
  throw new Error(`unknown target kind ${target.kind}`);
}

// Sync Cargo.lock to the bumped versions. The workspace crates use
// `version.workspace = true`, so bumping Cargo.toml's [workspace.package] version
// leaves their entries in Cargo.lock stale — and CI's `cargo test --workspace
// --locked` then REJECTS the out-of-date lock, failing every release build before
// it starts (this bit v4.5.6). `cargo update --workspace` rewrites only the
// workspace members' lock entries (never external deps). Kept OUT of the pure
// bumpVersion() so unit tests don't shell out; this is a CLI-only side effect.
export function syncCargoLock(root = REPO_ROOT) {
  for (const args of [["update", "--workspace", "--offline"], ["update", "--workspace"]]) {
    try {
      execFileSync("cargo", args, { cwd: root, stdio: "inherit" });
      return true;
    } catch {
      /* try the next variant (offline first, then allow index access) */
    }
  }
  console.warn(
    "\n⚠  bump-version: could not run `cargo update --workspace` (is cargo installed?).\n" +
      "   Run it manually and commit Cargo.lock, or CI's `cargo test --workspace --locked`\n" +
      "   will fail the release on a stale lockfile.",
  );
  return false;
}

// Robust "run as a script" check. The naive `file://${process.argv[1]}` never
// matches on Windows (backslashes + a missing slash), so the CLI silently no-ops
// there; pathToFileURL normalizes both sides.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = process.argv[2];
  if (!version) {
    console.error("usage: node scripts/bump-version.mjs <version>");
    process.exit(2);
  }
  let promoted;
  try {
    promoted = bumpVersion(version);
  } catch (e) {
    // Expected failure mode (bad semver / empty [Unreleased]) — print the
    // message, not a stack trace.
    console.error(`\n${e.message}`);
    process.exit(1);
  }
  console.log(`bumped to ${version}`);
  console.log(
    promoted
      ? `promoted CHANGELOG.md [Unreleased] → [${version}]`
      : `CHANGELOG.md: no [Unreleased] section to promote (or [${version}] already exists)`,
  );
  const lockSynced = syncCargoLock();
  console.log(lockSynced ? "synced Cargo.lock to the workspace versions" : "Cargo.lock NOT synced (see warning above)");
}
