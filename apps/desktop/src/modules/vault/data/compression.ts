/**
 * Gzip helpers for vault uploads/downloads. Prefers the browser's native
 * CompressionStream / DecompressionStream — the work runs off the JS main
 * thread and is dramatically faster than the pure-JS fallback on big payloads
 * (a 130 MB CSV decompresses in ~50 ms native vs. several seconds blocking in
 * JS). Falls back to fflate when streams aren't available (vitest's jsdom
 * doesn't ship a working stream pipeline today). fflate is the app's only
 * zlib: the workspace-bundle code already used it, and shipping pako as well
 * put a second, redundant deflate implementation in the launch chunk.
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

import { gzipSync, gunzipSync } from "fflate";

const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

function streamsAvailable(): boolean {
  return (
    typeof CompressionStream !== "undefined" &&
    typeof DecompressionStream !== "undefined" &&
    typeof Response !== "undefined" &&
    typeof Blob !== "undefined"
  );
}

async function pipeThroughCodec(bytes: Uint8Array, codec: "gzip", direction: "compress" | "decompress"): Promise<Uint8Array> {
  const transform = direction === "compress"
    ? new CompressionStream(codec)
    : new DecompressionStream(codec);
  const stream = new Blob([bytes as BufferSource]).stream().pipeThrough(transform);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

export async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  if (streamsAvailable()) {
    try { return await pipeThroughCodec(bytes, "gzip", "compress"); } catch { /* fall through */ }
  }
  return gzipSync(bytes);
}

export function isGzipped(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === GZIP_MAGIC_0 && bytes[1] === GZIP_MAGIC_1;
}

export async function gunzipIfNeeded(bytes: Uint8Array): Promise<Uint8Array> {
  if (!isGzipped(bytes)) return bytes;
  if (streamsAvailable()) {
    try { return await pipeThroughCodec(bytes, "gzip", "decompress"); } catch { /* fall through */ }
  }
  return gunzipSync(bytes);
}
