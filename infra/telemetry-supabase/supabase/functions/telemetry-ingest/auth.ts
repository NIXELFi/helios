/**
 * Request authentication for telemetry-ingest. Two accepted methods:
 *
 *  1. Authorization: Bearer <service_role JWT>
 *     - compared byte-for-byte against env SUPABASE_SERVICE_ROLE_KEY.
 *  2. Device HMAC:
 *     - x-htp-device:    device id string (must be present)
 *     - x-htp-signature: hex(HMAC-SHA256(body, env TELEMETRY_HMAC_KEY))
 *
 * Anything else is rejected (caller responds 401).
 */

const encoder = new TextEncoder();

export type AuthResult =
  | { ok: true; method: "service_role" }
  | { ok: true; method: "hmac"; deviceId: string }
  | { ok: false };

export async function authenticate(req: Request, body: Uint8Array): Promise<AuthResult> {
  // Method 1: service-role bearer.
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const authHeader = req.headers.get("authorization");
  if (serviceKey && authHeader && authHeader.startsWith("Bearer ")) {
    const presented = authHeader.slice("Bearer ".length).trim();
    if (timingSafeEqual(encoder.encode(presented), encoder.encode(serviceKey))) {
      return { ok: true, method: "service_role" };
    }
  }

  // Method 2: device HMAC over the raw request body.
  const deviceId = req.headers.get("x-htp-device");
  const signatureHex = req.headers.get("x-htp-signature");
  const hmacKey = Deno.env.get("TELEMETRY_HMAC_KEY");
  if (deviceId && signatureHex && hmacKey) {
    const signature = hexToBytes(signatureHex);
    if (signature !== null && signature.length === 32) {
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(hmacKey),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );
      // crypto.subtle.verify compares the MAC in constant time.
      const valid = await crypto.subtle.verify(
        "HMAC",
        key,
        signature as BufferSource,
        body as BufferSource,
      );
      if (valid) return { ok: true, method: "hmac", deviceId };
    }
  }

  return { ok: false };
}

/** Constant-time byte comparison (length mismatch short-circuits, which is fine here). */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
