// Emit ONE platform's updater-manifest fragment from this build job's own
// artifacts. Run inside each matrix build job (after tauri-action), so the
// per-platform logic only ever sees the platform it just built — no
// cross-platform / cross-arch filename guessing.
//
// The complete latest.json is assembled later, once, by scripts/assemble-
// updater-json.mjs in a single `updater` job. Splitting it this way is what
// removes the old race: no build job writes latest.json (tauri-action runs with
// uploadUpdaterJson:false), so parallel jobs can't clobber each other's keys.
//
// Inputs (env):
//   TARGET          - the Tauri updater platform key (e.g. "darwin-aarch64")
//   ARTIFACT_PATHS  - JSON array of files tauri-action produced (its
//                     `artifactPaths` output)
// Output: fragment.json = { target, bundle, signature } in the CWD.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { basename } from "node:path";

const target = process.env.TARGET;
if (!target) {
  console.error("updater-fragment: TARGET env is required");
  process.exit(1);
}

let paths;
try {
  paths = JSON.parse(process.env.ARTIFACT_PATHS || "[]");
} catch (err) {
  console.error("updater-fragment: ARTIFACT_PATHS is not valid JSON:", err.message);
  process.exit(1);
}
if (!Array.isArray(paths) || paths.length === 0) {
  console.error("updater-fragment: no artifact paths were provided");
  process.exit(1);
}

// The updater bundle is the artifact that has a sibling `.sig` (Tauri signs only
// the updater payload). Derive candidates from the .sig files so we don't depend
// on bundle extensions (which differ by platform and Tauri version).
const sigs = paths.filter((p) => p.endsWith(".sig"));
const candidates = sigs
  .map((s) => s.slice(0, -".sig".length))
  .filter((bundle) => existsSync(bundle + ".sig"));

if (candidates.length === 0) {
  console.error("updater-fragment: no signed updater bundle (.sig) found among:", paths);
  process.exit(1);
}

// When a platform produces more than one signed bundle (Windows: NSIS setup.exe
// AND WiX .msi), prefer NSIS to match `updaterJsonPreferNsis: true`.
const rank = (p) => {
  if (/-setup\.exe$/i.test(p)) return 0; // NSIS (preferred on Windows)
  if (/\.msi$/i.test(p)) return 1; // WiX
  return 0; // single-bundle platforms (macOS .app.tar.gz, Linux .AppImage*)
};
candidates.sort((a, b) => rank(a) - rank(b));
const bundle = candidates[0];

const signature = readFileSync(bundle + ".sig", "utf8").trim();
if (!signature) {
  console.error("updater-fragment: signature file is empty:", bundle + ".sig");
  process.exit(1);
}

const fragment = { target, bundle: basename(bundle), signature };
writeFileSync("fragment.json", JSON.stringify(fragment, null, 2) + "\n");
console.log(`updater-fragment: ${target} -> ${fragment.bundle}`);
