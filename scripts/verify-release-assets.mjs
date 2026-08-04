// Verify that every artifact referenced by latest.json is (a) intact and (b)
// actually signed by the updater key the shipped app trusts — BEFORE `publish`
// un-drafts the release.
//
// Why this exists: v5.3.1 shipped with its Windows and macOS-x64 bundles
// destroyed. CI had uploaded them correctly, then they were overwritten by an
// out-of-band upload that had round-tripped the binaries through a UTF-8 text
// pipeline: a BOM was prepended and every non-ASCII byte became U+FFFD
// (EF BF BD). The installer stopped being a valid PE, the .app.tar.gz stopped
// being a valid gzip, and the updater rejected both on signature check — so
// every Windows and Intel-Mac user was hard-stuck, unable to auto-update OR to
// reinstall by hand. Nothing in the pipeline noticed, because the release only
// ever checked that the build jobs exited 0.
//
// This script closes that gap: it re-downloads what the release ACTUALLY serves
// and cryptographically verifies it against the pubkey baked into the app. A
// corrupted, truncated, mismatched or clobbered asset fails the release instead
// of reaching users.
//
// Inputs (env):
//   MANIFEST     - path to the assembled latest.json (default "latest.json")
//   TAURI_CONF   - path to tauri.conf.json holding the trusted updater pubkey
//                  (default "apps/desktop/src-tauri/tauri.conf.json")
//   ASSET_DIR    - directory of already-downloaded release assets. Set this in
//                  CI: the release is still a DRAFT when this runs, and a draft's
//                  assets are not yet served from the stable
//                  releases/download/<tag>/<name> URLs recorded in latest.json —
//                  only the authenticated API can read them (`gh release
//                  download`). When unset, each manifest URL is fetched directly,
//                  which is the right mode for auditing an already-published
//                  release.
// Exit code 0 = every platform verified; 1 = at least one failed.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";

// --- minisign / Tauri updater signature format ------------------------------
// Both the pubkey and the signature are base64 of a two-line minisign block.
// The payload line decodes to: algorithm(2) || key_id(8) || body(32 pub | 64 sig).
// Algorithm "Ed" signs the file bytes; "ED" signs BLAKE2b-512 of the file bytes
// (Tauri emits "ED").
const ALG_PREHASHED = "ED";

function decodeMinisignBlock(b64) {
  const text = Buffer.from(b64, "base64").toString("utf8");
  const payload = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("untrusted comment:") && !l.startsWith("trusted comment:"));
  if (!payload) throw new Error("malformed minisign block: no payload line");
  const raw = Buffer.from(payload, "base64");
  return { alg: raw.subarray(0, 2).toString("ascii"), keyId: raw.subarray(2, 10).toString("hex"), body: raw.subarray(10) };
}

// Node has no raw-Ed25519 key import, so wrap the 32-byte key in a minimal SPKI
// DER header (RFC 8410 id-Ed25519).
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
function ed25519KeyFromRaw(raw32) {
  return createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, raw32]),
    format: "der",
    type: "spki",
  });
}

/**
 * Verify one artifact's bytes against its manifest signature.
 * Returns { ok: true } or { ok: false, reason } — never throws on a bad asset,
 * so the caller can report every platform rather than dying on the first.
 */
export function verifyArtifact({ bytes, signatureB64, pubkeyB64 }) {
  const pub = decodeMinisignBlock(pubkeyB64);
  let sig;
  try {
    sig = decodeMinisignBlock(signatureB64);
  } catch (e) {
    return { ok: false, reason: `signature is not a valid minisign block (${e.message})` };
  }
  if (sig.keyId !== pub.keyId) {
    return { ok: false, reason: `signed by key ${sig.keyId}, but the app trusts ${pub.keyId} — wrong signing key` };
  }
  // Catch the exact v5.3.1 failure mode with a legible message rather than a
  // bare "signature mismatch".
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    const fffd = countFffd(bytes);
    return {
      ok: false,
      reason:
        `artifact begins with a UTF-8 BOM (EF BB BF) and contains ${fffd.toLocaleString()} U+FFFD ` +
        `replacement sequences — the binary was corrupted by a text-mode round-trip, not uploaded as bytes`,
    };
  }
  const message = sig.alg === ALG_PREHASHED ? createHash("blake2b512").update(bytes).digest() : bytes;
  const ok = edVerify(null, message, ed25519KeyFromRaw(pub.body), sig.body);
  return ok ? { ok: true } : { ok: false, reason: "signature does not match the artifact bytes" };
}

function countFffd(buf) {
  let n = 0;
  for (let i = 0; i + 2 < buf.length; i++) {
    if (buf[i] === 0xef && buf[i + 1] === 0xbf && buf[i + 2] === 0xbd) n++;
  }
  return n;
}

// --- main -------------------------------------------------------------------

async function main() {
  const manifestPath = process.env.MANIFEST || "latest.json";
  const confPath = process.env.TAURI_CONF || "apps/desktop/src-tauri/tauri.conf.json";

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const pubkeyB64 = JSON.parse(readFileSync(confPath, "utf8"))?.plugins?.updater?.pubkey;
  if (!pubkeyB64) {
    console.error(`verify-release-assets: no plugins.updater.pubkey in ${confPath}`);
    process.exit(1);
  }

  const targets = Object.entries(manifest.platforms ?? {});
  if (targets.length === 0) {
    console.error("verify-release-assets: latest.json lists no platforms");
    process.exit(1);
  }

  const assetDir = process.env.ASSET_DIR;
  const source = assetDir ? `local assets in ${assetDir}/` : "the published download URLs";
  console.log(`verify-release-assets: checking ${targets.length} platform(s) for ${manifest.version} against ${source}`);
  const failures = [];

  for (const [target, entry] of targets) {
    // The manifest URL is the source of truth for WHICH file backs this
    // platform; in ASSET_DIR mode we resolve its basename on disk so a draft
    // release can be verified before it goes live.
    const name = entry.url.split("/").pop();
    let bytes;
    try {
      if (assetDir) {
        bytes = readFileSync(join(assetDir, name));
      } else {
        const res = await fetch(entry.url, { redirect: "follow" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        bytes = Buffer.from(await res.arrayBuffer());
      }
    } catch (e) {
      failures.push(`${target}: could not read ${assetDir ? name : entry.url} (${e.message})`);
      continue;
    }
    const { ok, reason } = verifyArtifact({ bytes, signatureB64: entry.signature, pubkeyB64 });
    const size = bytes.length.toLocaleString();
    if (ok) {
      console.log(`  OK    ${target.padEnd(16)} ${size.padStart(14)} bytes  ${name}`);
    } else {
      console.log(`  FAIL  ${target.padEnd(16)} ${size.padStart(14)} bytes  ${name}`);
      failures.push(`${target}: ${reason}`);
    }
  }

  if (failures.length > 0) {
    console.error(`\nverify-release-assets: ${failures.length} platform(s) FAILED verification:`);
    for (const f of failures) console.error(`  - ${f}`);
    console.error("\nThe release has NOT been published. Re-run the release so CI rebuilds and");
    console.error("re-uploads the bundles; never upload release binaries by hand.");
    process.exit(1);
  }
  console.log("verify-release-assets: all platforms verified against the app's updater pubkey");
}

// Only run when invoked directly, so the unit test can import verifyArtifact.
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
