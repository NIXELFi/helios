import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign, createHash, randomBytes } from "node:crypto";
import { verifyArtifact } from "../verify-release-assets.mjs";

// Build the minisign-style base64 blocks the Tauri updater actually uses:
// base64( "untrusted comment: ...\n" + base64(alg||keyId||body) + "\n" ).
function block(alg, keyId, body) {
  const payload = Buffer.concat([Buffer.from(alg, "ascii"), keyId, body]).toString("base64");
  return Buffer.from(`untrusted comment: test\n${payload}\n`).toString("base64");
}

// Node exports Ed25519 keys as DER; the raw 32-byte public key is the tail, and
// the raw 32-byte seed sits at the tail of the PKCS8 export.
function makeSigner(keyId = randomBytes(8)) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return {
    keyId,
    pubkeyB64: block("Ed", keyId, rawPub),
    // Tauri signs BLAKE2b-512 of the file ("ED" = prehashed).
    sign: (bytes) => block("ED", keyId, edSign(null, createHash("blake2b512").update(bytes).digest(), privateKey)),
  };
}

test("accepts an artifact signed by the trusted key", () => {
  const signer = makeSigner();
  const bytes = Buffer.from("MZ\x90\x00 pretend installer", "binary");
  const res = verifyArtifact({ bytes, signatureB64: signer.sign(bytes), pubkeyB64: signer.pubkeyB64 });
  assert.equal(res.ok, true);
});

test("rejects an artifact whose bytes changed after signing", () => {
  const signer = makeSigner();
  const signature = signer.sign(Buffer.from("original bytes"));
  const res = verifyArtifact({ bytes: Buffer.from("tampered bytes"), signatureB64: signature, pubkeyB64: signer.pubkeyB64 });
  assert.equal(res.ok, false);
  assert.match(res.reason, /does not match/);
});

test("rejects an artifact signed by a different key", () => {
  const trusted = makeSigner();
  const attacker = makeSigner();
  const bytes = Buffer.from("payload");
  const res = verifyArtifact({ bytes, signatureB64: attacker.sign(bytes), pubkeyB64: trusted.pubkeyB64 });
  assert.equal(res.ok, false);
  assert.match(res.reason, /wrong signing key/);
});

// The v5.3.1 regression: binaries round-tripped through a UTF-8 text pipeline
// gain a BOM and lose every non-ASCII byte to U+FFFD. Verified explicitly so the
// failure reports the real cause instead of a bare signature mismatch.
test("reports UTF-8 text-mode corruption by name", () => {
  const signer = makeSigner();
  const clean = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0xff, 0xfe]);
  const signature = signer.sign(clean);
  const corrupted = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]), // BOM
    Buffer.from([0x4d, 0x5a]), // "MZ" survives (ASCII)
    Buffer.from([0xef, 0xbf, 0xbd]), // 0x90 -> U+FFFD
    Buffer.from([0x00]),
    Buffer.from([0xef, 0xbf, 0xbd]), // 0xff -> U+FFFD
    Buffer.from([0xef, 0xbf, 0xbd]), // 0xfe -> U+FFFD
  ]);
  const res = verifyArtifact({ bytes: corrupted, signatureB64: signature, pubkeyB64: signer.pubkeyB64 });
  assert.equal(res.ok, false);
  assert.match(res.reason, /UTF-8 BOM/);
  assert.match(res.reason, /3 U\+FFFD/);
});

test("rejects a malformed signature block instead of throwing", () => {
  const signer = makeSigner();
  const res = verifyArtifact({
    bytes: Buffer.from("payload"),
    signatureB64: Buffer.from("untrusted comment: only a comment\n").toString("base64"),
    pubkeyB64: signer.pubkeyB64,
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /not a valid minisign block/);
});
