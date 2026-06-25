// The plugin manifest: the contract a plugin declares and the host enforces.
// `validateManifest` is a PURE function reused by three callers: the host loader
// (before mounting), the `helios-plugin check` compliance validator (authoring
// time), and the review pipeline (Sub-project D). Keep it dependency-free.

import { ALL_PERMISSIONS, type PermissionKey } from "./capabilities";

/** The Host SDK contract version this build implements. A plugin's `sdk` range
 *  is checked against this. Bump the major when the API surface breaks. */
export const SDK_CONTRACT_VERSION = "1.0.0";

/** The package format this build can load. */
export const SUPPORTED_FORMAT = 1;

export interface PluginManifest {
  format: number;
  /** Stable, unique, immutable across versions. Used for the plugin origin and
   *  the storage namespace. e.g. "aero.downforce-calculator". */
  id: string;
  name: string;
  /** The plugin's OWN semver — independent of the Helios app version. */
  version: string;
  description?: string;
  /** Owning subteam (ties into the org-roles model). */
  subteam?: string;
  icon?: string;
  /** Path within the bundle to the HTML entry loaded into the sandbox. */
  entry: string;
  /** Compatible Host SDK contract range, e.g. "^1.0.0". */
  sdk: string;
  /** DEFAULT-DENY: [] = a pure-sandbox plugin. Every door must be listed. */
  permissions: PermissionKey[];
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

// Lowercase letters/digits in dot- or dash-separated segments.
const ID_RE = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Validate an untrusted manifest object. Never throws; returns a structured
 *  result so callers (loader, CLI, pipeline) can present errors uniformly. */
export function validateManifest(input: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (typeof input !== "object" || input === null) {
    return { ok: false, errors: ["manifest must be a JSON object"], warnings };
  }
  const m = input as Record<string, unknown>;

  if (m.format !== SUPPORTED_FORMAT) {
    errors.push(`unsupported manifest format ${String(m.format)} (this build loads format ${SUPPORTED_FORMAT})`);
  }
  if (typeof m.id !== "string" || !ID_RE.test(m.id)) {
    errors.push("id must be lowercase letters/digits in dot/dash segments, e.g. 'aero.downforce-calculator'");
  }
  if (typeof m.name !== "string" || m.name.trim() === "") {
    errors.push("name is required");
  }
  if (typeof m.version !== "string" || !SEMVER_RE.test(m.version)) {
    errors.push("version must be semver, e.g. '1.4.0'");
  }
  if (typeof m.entry !== "string" || m.entry.trim() === "") {
    errors.push("entry is required (path to the bundle's HTML entry)");
  }
  if (typeof m.sdk !== "string" || m.sdk.trim() === "") {
    errors.push("sdk is required (compatible SDK contract range, e.g. '^1.0.0')");
  }
  if (!Array.isArray(m.permissions)) {
    errors.push("permissions must be an array (use [] for a pure-sandbox plugin)");
  } else {
    for (const p of m.permissions) {
      if (typeof p !== "string" || !(ALL_PERMISSIONS as readonly string[]).includes(p)) {
        errors.push(`unknown permission '${String(p)}' — allowed: ${ALL_PERMISSIONS.join(", ")}`);
      }
    }
  }
  if (m.subteam !== undefined && typeof m.subteam !== "string") {
    warnings.push("subteam should be a string");
  }
  if (m.description !== undefined && typeof m.description !== "string") {
    warnings.push("description should be a string");
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** Minimal SDK-compatibility check: does the plugin's declared `sdk` range
 *  accept the host contract version? Supports caret ranges and exact versions.
 *  A fuller semver-range matcher arrives with the marketplace (Sub-project B). */
export function isSdkCompatible(range: string, hostVersion: string = SDK_CONTRACT_VERSION): boolean {
  const host = hostVersion.split(".").map((n) => Number(n));
  const hostMajor = host[0];
  const hostMinor = host[1] ?? 0;
  if (hostMajor === undefined || Number.isNaN(hostMajor)) return false;

  const caret = range.startsWith("^");
  const parts = (caret ? range.slice(1) : range).split(".").map((n) => Number(n));
  const major = parts[0];
  if (major === undefined || Number.isNaN(major)) return false;

  if (caret) {
    // ^1.2.3 := same major (and >= minor when major is 0, but host is >=1 here).
    if (major !== hostMajor) return false;
    if (hostMajor === 0) return (parts[1] ?? 0) === hostMinor;
    return true;
  }
  // Exact / prefix match: every provided segment must equal the host's.
  return parts.every((n, i) => n === host[i]);
}
