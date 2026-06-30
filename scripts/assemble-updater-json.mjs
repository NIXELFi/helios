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

// Resolve each platform target to its uploaded updater-bundle asset URL. We match
// by platform/arch pattern on the ACTUAL uploaded asset names, NOT by the local
// bundle basename: tauri-action renames the two macOS .app.tar.gz bundles on
// upload to disambiguate arch (Helios_aarch64.app.tar.gz / Helios_x64.app.tar.gz),
// so the local basename ("Helios.app.tar.gz") never equals the asset name.
const assetsRaw =
  process.env.ASSETS_JSON ??
  execFileSync("gh", ["release", "view", tag, "--json", "assets"], { encoding: "utf8" });
const assets = (JSON.parse(assetsRaw).assets ?? []).filter((a) => !a.name.endsWith(".sig"));

// "owner/repo" for building stable download URLs (always set in GitHub Actions).
const repo =
  process.env.GITHUB_REPOSITORY ??
  execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], {
    encoding: "utf8",
  }).trim();

// The updater bundle per platform. Anchored to the bundle extension so the
// first-install-only installers (.dmg / .deb / .rpm) are never picked.
const MATCHERS = {
  "darwin-aarch64": (n) => /\.app\.tar\.gz$/i.test(n) && /(aarch64|arm64)/i.test(n),
  "darwin-x86_64": (n) => /\.app\.tar\.gz$/i.test(n) && /(x64|x86_64)/i.test(n),
  "windows-x86_64": (n) => /-setup\.exe$/i.test(n) || /\.msi$/i.test(n),
  "linux-x86_64": (n) => /\.AppImage$/i.test(n),
};

const isNsis = (n) => /-setup\.exe$/i.test(n);
function assetUrlForTarget(target) {
  const match = MATCHERS[target];
  if (!match) throw new Error(`assemble-updater-json: unknown target "${target}"`);
  // Prefer NSIS over WiX (.msi) on Windows when both exist (updaterJsonPreferNsis).
  const candidates = assets.filter((a) => match(a.name)).sort((a, b) => Number(isNsis(b.name)) - Number(isNsis(a.name)));
  const asset = candidates[0];
  if (!asset) {
    throw new Error(
      `assemble-updater-json: no uploaded asset matches target "${target}" among [${assets.map((a) => a.name).join(", ")}]`,
    );
  }
  // Use the STABLE tag-based download URL, NOT the asset's draft browser_download_url
  // (which is `releases/download/untagged-<id>/...` and dies once the release is
  // published). This matches the URL form tauri-action itself writes.
  return `https://github.com/${repo}/releases/download/${tag}/${asset.name}`;
}

const platforms = {};
for (const f of fragments) {
  if (!f.target || !f.signature) {
    throw new Error(`assemble-updater-json: malformed fragment: ${JSON.stringify(f)}`);
  }
  if (platforms[f.target]) {
    throw new Error(`assemble-updater-json: duplicate platform key "${f.target}"`);
  }
  platforms[f.target] = { signature: f.signature, url: assetUrlForTarget(f.target) };
}

const manifest = {
  version: tag.replace(/^v/, ""),
  notes: `Helios ${tag}`,
  pub_date: new Date().toISOString(),
  platforms,
};

writeFileSync("latest.json", JSON.stringify(manifest, null, 2) + "\n");
console.log(`assemble-updater-json: latest.json for ${Object.keys(platforms).sort().join(", ")}`);
