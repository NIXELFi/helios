/**
 * Gzip helpers for vault uploads/downloads. Uses pako so we get the same
 * deterministic behaviour in Tauri's webview, in vitest+jsdom, and in node.
 *
 * Why we compress: Supabase free plan caps single-file uploads at 50 MiB.
 * MoTeC / log-style CSVs typically compress 5–10×, which keeps everything
 * the team currently records under the cap. Gzip is fully lossless — the
 * version row stores the sha256 of the ORIGINAL (uncompressed) bytes, so
 * a successful round-trip yields byte-identical data.
 *
 * Backward compatibility: storage paths are unchanged (still sha-of-original).
 * Download checks the first two bytes of the fetched blob — if they're the
 * gzip magic bytes (1f 8b), decompress; otherwise treat as legacy raw bytes.
 */

import { gzip as pakoGzip, ungzip as pakoUngzip } from "pako";

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

export function gzipBytes(bytes: Uint8Array): Uint8Array {
  return pakoGzip(bytes);
}

export function isGzipped(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === GZIP_MAGIC_0 && bytes[1] === GZIP_MAGIC_1;
}

export function gunzipIfNeeded(bytes: Uint8Array): Uint8Array {
  if (!isGzipped(bytes)) return bytes;
  return pakoUngzip(bytes);
}
