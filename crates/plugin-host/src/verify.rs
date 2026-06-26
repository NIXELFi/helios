//! Bundle integrity + authenticity verification — the client-side counterpart to
//! the marketplace's publish-time signing. Pure (no Tauri), so the crypto contract
//! is unit-tested with real Ed25519 in CI and locally. The desktop install command
//! calls these on the downloaded bytes BEFORE unpacking; a failure aborts install.

use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use sha2::{Digest, Sha256};

/// Lowercase hex sha256 of `bytes` (matches the content-address / storage key).
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut s = String::with_capacity(64);
    for b in digest {
        // {:02x} per byte → 64-char lowercase hex.
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// True iff `bytes` hash to `expected_hex` (case-insensitive on the hex).
pub fn verify_sha256(bytes: &[u8], expected_hex: &str) -> bool {
    sha256_hex(bytes).eq_ignore_ascii_case(expected_hex)
}

/// The canonical signing message. MUST be byte-identical to
/// `marketplace.signing_message(...)` in 20260626000200_marketplace_signing.sql:
/// a domain tag and LF-separated fields, sha256 lowercased. Any divergence makes
/// every signature fail to verify.
pub fn signing_message(plugin_id: &str, version: &str, sha256_hex: &str, bytes: u64) -> Vec<u8> {
    format!(
        "helios-plugin-v1\n{}\n{}\n{}\n{}",
        plugin_id,
        version,
        sha256_hex.to_ascii_lowercase(),
        bytes
    )
    .into_bytes()
}

/// Verify a base64 Ed25519 detached `signature_b64` over `message` with the base64
/// `public_key_b64` (32-byte key from `signing_public_key()`). Returns false on any
/// decode/length/verify failure — never panics, never throws.
pub fn verify_signature(public_key_b64: &str, signature_b64: &str, message: &[u8]) -> bool {
    let b64 = base64::engine::general_purpose::STANDARD;
    let pk_bytes = match b64.decode(public_key_b64.trim()) {
        Ok(b) => b,
        Err(_) => return false,
    };
    let sig_bytes = match b64.decode(signature_b64.trim()) {
        Ok(b) => b,
        Err(_) => return false,
    };
    let pk_arr: [u8; 32] = match pk_bytes.as_slice().try_into() {
        Ok(a) => a,
        Err(_) => return false,
    };
    let key = match VerifyingKey::from_bytes(&pk_arr) {
        Ok(k) => k,
        Err(_) => return false,
    };
    let sig = match Signature::from_slice(&sig_bytes) {
        Ok(s) => s,
        Err(_) => return false,
    };
    key.verify(message, &sig).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use ed25519_dalek::{Signer, SigningKey};

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[test]
    fn sha256_is_lowercase_hex_64() {
        let h = sha256_hex(b"hello");
        assert_eq!(h.len(), 64);
        assert_eq!(h, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
        assert!(verify_sha256(b"hello", &h.to_uppercase())); // case-insensitive
        assert!(!verify_sha256(b"hello!", &h));
    }

    #[test]
    fn canonical_message_is_stable() {
        let m = signing_message("aero.x", "1.2.0", "ABCDEF", 1024);
        // sha256 field lowercased; LF separators; domain tag first.
        assert_eq!(
            std::str::from_utf8(&m).unwrap(),
            "helios-plugin-v1\naero.x\n1.2.0\nabcdef\n1024"
        );
    }

    #[test]
    fn verifies_a_valid_signature_round_trip() {
        // Stand in for the server: sign the exact canonical message with Ed25519.
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let pk_b64 = b64(sk.verifying_key().as_bytes());

        let sha = sha256_hex(b"the-bundle-bytes");
        let msg = signing_message("aero.downforce", "2.0.0", &sha, 4096);
        let sig_b64 = b64(&sk.sign(&msg).to_bytes());

        assert!(verify_signature(&pk_b64, &sig_b64, &msg));
    }

    #[test]
    fn rejects_tampered_message_wrong_key_and_garbage() {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let pk_b64 = b64(sk.verifying_key().as_bytes());
        let msg = signing_message("aero", "1.0.0", &sha256_hex(b"x"), 10);
        let sig_b64 = b64(&sk.sign(&msg).to_bytes());

        // Tampered message (e.g. attacker swapped the bundle → different sha/bytes).
        let tampered = signing_message("aero", "1.0.0", &sha256_hex(b"y"), 10);
        assert!(!verify_signature(&pk_b64, &sig_b64, &tampered));

        // Different key.
        let other = SigningKey::from_bytes(&[9u8; 32]);
        assert!(!verify_signature(&b64(other.verifying_key().as_bytes()), &sig_b64, &msg));

        // Garbage inputs never panic, always false.
        assert!(!verify_signature("not-base64!!", &sig_b64, &msg));
        assert!(!verify_signature(&pk_b64, "not-base64!!", &msg));
        assert!(!verify_signature(&pk_b64, &b64(&[0u8; 10]), &msg)); // wrong sig length
        assert!(!verify_signature(&b64(&[0u8; 8]), &sig_b64, &msg)); // wrong key length
    }
}
