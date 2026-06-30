// Assemble the complete Tauri updater manifest (latest.json) from the per-
// platform fragments emitted by scripts/updater-fragment.mjs, then leave it in
// the CWD for the workflow to upload. Runs ONCE, in a single `updater` job after
// the parallel matrix builds finish — it is the sole writer of latest.json, so
// there is no concurrent read-modify-write to race on (the old serial-build bug).
//
// Inputs (env):
//   RELEASE_TAG  - the release tag (e.g. "v4.5.6"); the leading "v" is stripped
//                  for the manifest `version` (Tauri compares semver).
//   FRAG_DIR     - directory holding the downloaded fragment artifacts; each
//                  fragment lands at <FRAG_DIR>/<artifact-name>/fragment.json.
//   ASSETS_JSON  - (optional, for tests) JSON `{ "assets": [...] }`. When unset,
//                  the release's assets are read via `gh release view`.
// Output: latest.json in the CWD.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const tag = process.env.RELEASE_TAG;
if (!tag) {
  console.error("assemble-updater-json: RELEASE_TAG env is required");
  process.exit(1);
}
const fragDir = process.env.FRAG_DIR || "fragments";

// Collect every fragment.json under FRAG_DIR (download-artifact nests each
// artifact in its own subdirectory).
const fragments = [];
function collect(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) collect(p);
    else if (entry.name === "fragment.json") fragments.push(JSON.parse(readFileSync(p, "utf8")));
  }
}
collect(fragDir);

if (fragments.length === 0) {
  console.error(`assemble-updater-json: no fragment.json found under ${fragDir}`);
  process.exit(1);
}

// Resolve each bundle filename to its uploaded release-asset download URL. URLs
// come from the ACTUAL uploaded assets (not a guessed pattern), so the manifest
// can't drift from what shipped.
const assetsRaw =
  process.env.ASSETS_JSON ??
  execFileSync("gh", ["release", "view", tag, "--json", "assets"], { encoding: "utf8" });
const assets = JSON.parse(assetsRaw).assets ?? [];
const urlForBundle = (name) => {
  const asset = assets.find((a) => a.name === name);
  if (!asset || !asset.url) {
    throw new Error(`assemble-updater-json: no uploaded asset matches bundle "${name}"`);
  }
  return asset.url;
};

const platforms = {};
for (const f of fragments) {
  if (!f.target || !f.bundle || !f.signature) {
    throw new Error(`assemble-updater-json: malformed fragment: ${JSON.stringify(f)}`);
  }
  if (platforms[f.target]) {
    throw new Error(`assemble-updater-json: duplicate platform key "${f.target}"`);
  }
  platforms[f.target] = { signature: f.signature, url: urlForBundle(f.bundle) };
}

const manifest = {
  version: tag.replace(/^v/, ""),
  notes: `Helios ${tag}`,
  pub_date: new Date().toISOString(),
  platforms,
};

writeFileSync("latest.json", JSON.stringify(manifest, null, 2) + "\n");
console.log(`assemble-updater-json: latest.json for ${Object.keys(platforms).sort().join(", ")}`);
