#!/usr/bin/env node
// helios-plugin — the Helios add-on author CLI.
//
//   helios-plugin check <plugin-dir>
//
// Validates a plugin's manifest and scans its built bundle for compliance with
// the sandbox rules: no forbidden host/network/DOM-escape APIs, and declared
// permissions that match what the code actually uses. This is the SAME set of
// checks the marketplace review pipeline (Sub-project D) runs, so a plugin that
// passes here is most of the way through review.
//
// NOTE (MVP): the rules below are intentionally duplicated from
// @helios/plugin-sdk's catalog/validateManifest in plain JS so the CLI has zero
// build step. Once the SDK ships a compiled entry, this should import them
// directly to keep a single source of truth.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

const ALLOWED_PERMISSIONS = ["file.read", "file.write", "storage", "engine:matlab"];

// Forbidden API patterns. Each plugin runs in an opaque-origin sandbox with a
// strict CSP, so these either CANNOT work or are an attempt to escape the box.
// NOTE: we deliberately do NOT forbid `window.parent`/`postMessage` here — the
// bundled SDK uses them legitimately to reach the broker, and we scan the
// COMPILED bundle. We focus on APIs the SDK never uses, so their presence is a
// genuine red flag: network, alternate storage, cookies, dynamic eval.
// The lookbehind `(?<![.\w])` excludes member-access forms like `store.fetch(`
// or `obj.eval(` so we only flag the GLOBAL builtins, not unrelated methods that
// happen to share the name. (This scan is a heuristic author aid, not the
// security control — the CSP/sandbox is. It can be defeated by aliasing.)
const FORBIDDEN = [
  { re: /(?<![.\w])fetch\s*\(/, msg: "network call `fetch(` — blocked by CSP. Use a brokered capability instead." },
  { re: /\bXMLHttpRequest\b/, msg: "`XMLHttpRequest` — network is blocked by CSP." },
  { re: /\bWebSocket\b/, msg: "`WebSocket` — network is blocked by CSP." },
  { re: /\bnavigator\.sendBeacon\b/, msg: "`sendBeacon` — network is blocked by CSP." },
  { re: /\bdocument\.cookie\b/, msg: "`document.cookie` — unavailable in the sandbox." },
  { re: /\blocalStorage\b/, msg: "`localStorage` — unavailable in the sandbox. Use the SDK `storage` API." },
  { re: /\bsessionStorage\b/, msg: "`sessionStorage` — unavailable in the sandbox. Use the SDK `storage` API." },
  { re: /\bindexedDB\b/, msg: "`indexedDB` — unavailable in the sandbox. Use the SDK `storage` API." },
  { re: /(?<![.\w])eval\s*\(/, msg: "`eval(` — dynamic code execution is not allowed." },
];

// Map a used capability to the permission it requires. We match BOTH the SDK
// helper names (save(), storage.set()) and the raw wire-method strings
// ("file.write", "storage.set") so the check works whether the plugin used the
// SDK helpers or spoke the protocol directly.
const USAGE_TO_PERMISSION = [
  { re: /\bopenFile\s*\(|["']file\.read["']/, perm: "file.read" },
  { re: /\bsave\s*\(|["']file\.write["']/, perm: "file.write" },
  { re: /\bstorage\.(get|set|keys|delete)\s*\(|["']storage\.(get|set|keys|delete)["']/, perm: "storage" },
  { re: /\bengine\.matlab\.run\s*\(|["']engine\.matlab\.run["']/, perm: "engine:matlab" },
];

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
  let errorCount = 0;
  let warnCount = 0;

  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) {
    fail(`no manifest.json found in ${dir}`);
    return 1;
  }

  let manifest;
  try {
    // Strip a leading UTF-8 BOM — editors/PowerShell add one and JSON.parse chokes.
    let raw = readFileSync(manifestPath, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // strip UTF-8 BOM
    manifest = JSON.parse(raw);
  } catch (e) {
    fail(`manifest.json is not valid JSON: ${e.message}`);
    return 1;
  }

  const manifestErrors = validateManifestJs(manifest);
  if (manifestErrors.length) {
    for (const e of manifestErrors) fail(`manifest: ${e}`);
    errorCount += manifestErrors.length;
  } else {
    ok(`manifest valid — ${manifest.id}@${manifest.version} (permissions: ${JSON.stringify(manifest.permissions)})`);
  }

  const declared = new Set(Array.isArray(manifest.permissions) ? manifest.permissions : []);
  const used = new Set();

  // Scan the built bundle (dist/ if present, else the dir itself).
  const scanRoot = existsSync(join(dir, "dist")) ? join(dir, "dist") : dir;
  const files = collectSourceFiles(scanRoot);

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const rule of FORBIDDEN) {
      if (rule.re.test(text)) {
        fail(`${file}: ${rule.msg}`);
        errorCount++;
      }
    }
    for (const u of USAGE_TO_PERMISSION) {
      if (u.re.test(text)) used.add(u.perm);
    }
  }

  // Declared-vs-used reconciliation.
  for (const perm of used) {
    if (!declared.has(perm)) {
      fail(`code uses a '${perm}' capability but the manifest does not declare it`);
      errorCount++;
    }
  }
  for (const perm of declared) {
    if (!used.has(perm)) {
      warn(`manifest declares '${perm}' but no code uses it — drop it to minimise the trust surface`);
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
