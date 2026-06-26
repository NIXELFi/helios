// Automated review checks (Sub-project D, desktop-side per open-decision #1).
// A reviewer runs this on a pending version: download the content-addressed bundle
// via a short-lived signed URL, unzip it in-memory, and run the SHARED `scanBundle`
// rules (the same engine the author CLI runs). The resulting report is attached to
// the version via review_plugin_version. This is a heuristic aid — the sandbox/CSP
// is the real control — so a clean report is necessary-not-sufficient for approval.

import { unzipSync, strFromU8 } from "fflate";
import { scanBundle } from "@helios/plugin-sdk";
import type { ComplianceFinding, PluginManifest } from "@helios/plugin-sdk";

const SCANNABLE_EXTENSIONS = [".js", ".mjs", ".html", ".css"];

export interface ChecksReport {
  ranAt: string;
  findings: ComplianceFinding[];
  errorCount: number;
  warnCount: number;
  /** How many scannable files were inspected (0 → suspicious / empty bundle). */
  fileCount: number;
}

/** Download + unzip + scan a bundle. `ranAt` is supplied by the caller (or now)
 *  so the function stays deterministic/testable. */
export async function runChecks(
  signedUrl: string,
  manifest: PluginManifest,
  ranAt: string = new Date().toISOString(),
): Promise<ChecksReport> {
  const res = await fetch(signedUrl);
  if (!res.ok) throw new Error(`could not download bundle: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (e) {
    throw new Error(`bundle is not a readable zip: ${e instanceof Error ? e.message : String(e)}`);
  }

  const files: Record<string, string> = {};
  for (const [path, data] of Object.entries(entries)) {
    if (SCANNABLE_EXTENSIONS.some((ext) => path.toLowerCase().endsWith(ext))) {
      files[path] = strFromU8(data);
    }
  }

  const findings = scanBundle(files, manifest);
  return {
    ranAt,
    findings,
    errorCount: findings.filter((f) => f.level === "error").length,
    warnCount: findings.filter((f) => f.level === "warn").length,
    fileCount: Object.keys(files).length,
  };
}
