#!/usr/bin/env node
// helios-plugin — the Helios add-on author CLI.
//
//   helios-plugin check <plugin-dir>
//
// Validates a plugin's manifest and scans its built bundle for compliance with
// the sandbox rules: no forbidden host/network/DOM-escape APIs, and declared
// permissions that match what the code actually uses. The bundle-scan rules are
// the SAME `scanBundle` the marketplace review pipeline (Sub-project D) runs —
// both import them from `../src/compliance.mjs`, so passing here is most of the
// way through review and there is no rule drift between the two.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, extname, relative } from "node:path";
import { scanBundle, ALLOWED_PERMISSIONS } from "../src/compliance.mjs";

function fail(msg) {
  console.error(`\x1b[31m✗\x1b[0m ${msg}`);
}
function warn(msg) {
  console.warn(`\x1b[33m!\x1b[0m ${msg}`);
}
function ok(msg) {
  console.log(`\x1b[32m✓\x1b[0m ${msg}`);
}

function validateManifestJs(m) {
  const errors = [];
  if (typeof m !== "object" || m === null) return ["manifest must be a JSON object"];
  if (m.format !== 1) errors.push(`unsupported manifest format ${m.format} (expected 1)`);
  if (typeof m.id !== "string" || !/^[a-z0-9]+(?:[-.][a-z0-9]+)*$/.test(m.id))
    errors.push("id must be lowercase dot/dash segments, e.g. 'aero.downforce-calculator'");
  if (typeof m.name !== "string" || !m.name.trim()) errors.push("name is required");
  if (typeof m.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(m.version))
    errors.push("version must be semver, e.g. '1.4.0'");
  if (typeof m.entry !== "string" || !m.entry.trim()) errors.push("entry is required");
  else if (/\.\.|^\/|\\|^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(m.entry))
    errors.push("entry must be a relative path within the bundle (no '..', leading '/', backslash, or URL scheme)");
  if (typeof m.sdk !== "string" || !m.sdk.trim()) errors.push("sdk range is required, e.g. '^1.0.0'");
  if (!Array.isArray(m.permissions)) errors.push("permissions must be an array (use [] for pure sandbox)");
  else
    for (const p of m.permissions)
      if (!ALLOWED_PERMISSIONS.includes(p))
        errors.push(`unknown permission '${p}' — allowed: ${ALLOWED_PERMISSIONS.join(", ")}`);
  return errors;
}

function collectSourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...collectSourceFiles(full));
    else if ([".js", ".mjs", ".html", ".css"].includes(extname(name))) out.push(full);
  }
  return out;
}

function check(dir) {
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) {
    fail(`no manifest.json found in ${dir}`);
    return 1;
  }

  let manifest;
  try {
    // Strip a leading UTF-8 BOM — editors/PowerShell add one and JSON.parse chokes.
    let raw = readFileSync(manifestPath, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    manifest = JSON.parse(raw);
  } catch (e) {
    fail(`manifest.json is not valid JSON: ${e.message}`);
    return 1;
  }

  let errorCount = 0;
  let warnCount = 0;

  const manifestErrors = validateManifestJs(manifest);
  if (manifestErrors.length) {
    for (const e of manifestErrors) fail(`manifest: ${e}`);
    errorCount += manifestErrors.length;
  } else {
    ok(`manifest valid — ${manifest.id}@${manifest.version} (permissions: ${JSON.stringify(manifest.permissions)})`);
  }

  // Scan the built bundle (dist/ if present, else the dir itself) via the SHARED
  // rules. Build a path -> contents map (paths shown relative to the plugin dir).
  const scanRoot = existsSync(join(dir, "dist")) ? join(dir, "dist") : dir;
  const files = {};
  for (const abs of collectSourceFiles(scanRoot)) {
    files[relative(dir, abs)] = readFileSync(abs, "utf8");
  }

  for (const f of scanBundle(files, manifest)) {
    if (f.level === "error") {
      fail(f.path ? `${f.path}: ${f.message}` : f.message);
      errorCount++;
    } else {
      warn(f.message);
      warnCount++;
    }
  }

  console.log("");
  if (errorCount === 0) {
    ok(`compliance check passed${warnCount ? ` (${warnCount} warning${warnCount > 1 ? "s" : ""})` : ""}`);
    return 0;
  }
  fail(`compliance check failed — ${errorCount} error${errorCount > 1 ? "s" : ""}`);
  return 1;
}

function main() {
  const [cmd, dir] = process.argv.slice(2);
  if (cmd !== "check" || !dir) {
    console.log("usage: helios-plugin check <plugin-dir>");
    process.exit(cmd ? 1 : 0);
  }
  if (!existsSync(dir)) {
    fail(`directory not found: ${dir}`);
    process.exit(1);
  }
  process.exit(check(dir));
}

main();
