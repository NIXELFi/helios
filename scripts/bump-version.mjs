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
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

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

if (import.meta.url === `file://${process.argv[1]}`) {
  const version = process.argv[2];
  if (!version) {
    console.error("usage: node scripts/bump-version.mjs <version>");
    process.exit(2);
  }
  bumpVersion(version);
  console.log(`bumped to ${version}`);
}
