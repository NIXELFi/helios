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
  } else if (/\.\.|^\/|\\|^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(m.entry)) {
    // Path-traversal / absolute / scheme guard — the loader concatenates this
    // onto the bundle base, so it must stay a relative path inside the bundle.
    errors.push("entry must be a relative path within the bundle (no '..', leading '/', backslash, or URL scheme)");
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
    if (major !== hostMajor) return false;
    const reqMinor = parts[1] ?? 0;
    const reqPatch = parts[2] ?? 0;
    const hostPatch = host[2] ?? 0;
    // ^0.x.y pins the minor; otherwise the host must satisfy the requested floor
    // (>= minor.patch) within the same major — a host OLDER than the requested
    // minor must be refused, not accepted.
    if (hostMajor === 0) return reqMinor === hostMinor && hostPatch >= reqPatch;
    if (hostMinor !== reqMinor) return hostMinor > reqMinor;
    return hostPatch >= reqPatch;
  }
  // Exact / prefix match: every provided segment must equal the host's.
  return parts.every((n, i) => n === host[i]);
}
