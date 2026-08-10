import { invoke } from "@tauri-apps/api/core";
import { tableFromIPC } from "apache-arrow";
import type { Vector } from "apache-arrow";
import { ChannelStore } from "./channel-store";
import { RateGroup } from "./rate-group";
import type { ChannelMeta } from "./types";

// ---------------------------------------------------------------------------
// Binary envelope decode
//
// The `load_csv` Tauri command returns raw bytes (tauri::ipc::Response), not
// JSON — `invoke` resolves with an ArrayBuffer. Layout (must match
// apps/desktop/src-tauri/src/commands/load_csv.rs):
//
//   [u32 LE header_len][header JSON bytes][concatenated per-group IPC bytes]
//
// Per-group `ipc_offset`/`ipc_len` in the header are relative to the start of
// the concatenated blob (i.e. to byte `4 + header_len` of the buffer).
// ---------------------------------------------------------------------------

export interface RateGroupHeader {
  id: string;
  nominal_rate_hz: number;
  channel_metas: ChannelMeta[];
  ipc_offset: number;
  ipc_len: number;
}

export interface EnvelopeHeader {
  rate_groups: RateGroupHeader[];
  warnings: string[];
  duration_us: number;
}

export interface DecodedEnvelope {
  header: EnvelopeHeader;
  /** Concatenated per-group Arrow IPC bytes; header offsets index into this. */
  blob: Uint8Array;
}

/** Parse the binary envelope. Pure — unit-testable without Tauri. */
export function decodeEnvelope(buffer: ArrayBuffer): DecodedEnvelope {
  if (buffer.byteLength < 4) {
    throw new Error(`load_csv envelope too short: ${buffer.byteLength} bytes`);
  }
  const headerLen = new DataView(buffer).getUint32(0, true);
  const headerEnd = 4 + headerLen;
  if (headerEnd > buffer.byteLength) {
    throw new Error(
      `load_csv envelope corrupt: header_len ${headerLen} exceeds buffer (${buffer.byteLength} bytes)`,
    );
  }
  const headerBytes = new Uint8Array(buffer, 4, headerLen);
  const header = JSON.parse(new TextDecoder().decode(headerBytes)) as EnvelopeHeader;
  return { header, blob: new Uint8Array(buffer, headerEnd) };
}

/** Subarray view (no copy) of one group's Arrow IPC stream inside the blob. */
export function groupIpcBytes(env: DecodedEnvelope, g: RateGroupHeader): Uint8Array {
  if (g.ipc_offset < 0 || g.ipc_len < 0 || g.ipc_offset + g.ipc_len > env.blob.byteLength) {
    throw new Error(
      `load_csv envelope corrupt: group ${g.id} window [${g.ipc_offset}, +${g.ipc_len}) exceeds blob (${env.blob.byteLength} bytes)`,
    );
  }
  return env.blob.subarray(g.ipc_offset, g.ipc_offset + g.ipc_len);
}

// ---------------------------------------------------------------------------
// Bulk column extraction
//
// Arrow-JS `.get(i)` pays vector dispatch + a null check per call; we instead
// copy each chunk's underlying typed array once. Semantics pinned against
// apache-arrow@17: a chunk's `values` buffer is indexed WITHOUT `data.offset`
// (slicing subarrays the values buffer), while the validity bitmap is indexed
// WITH it (bit `data.offset + i`).
//
// Null semantics (deliberate correctness fix): null cells become NaN. The old
// per-cell path did `col.get(i) as number` and let the Float64Array store
// coerce Arrow nulls to 0 — silent data fabrication.
// ---------------------------------------------------------------------------

/** Copy a Float64 column into a dense Float64Array; nulls become NaN.
 *  Handles multi-chunk columns; pure-memcpy fast path when a chunk has no
 *  nulls. */
export function extractFloat64Column(col: Vector, numRows: number): Float64Array {
  const out = new Float64Array(numRows);
  let dst = 0;
  for (const data of col.data) {
    const len = data.length;
    if (dst + len > numRows) {
      throw new Error(`column chunks exceed row count ${numRows}`);
    }
    const values = data.values as unknown as Float64Array;
    if (data.nullCount === 0) {
      out.set(values.subarray(0, len), dst);
    } else {
      const bitmap = data.nullBitmap;
      const bitmapOffset = data.offset;
      for (let i = 0; i < len; i++) {
        const pos = bitmapOffset + i;
        const valid = ((bitmap[pos >> 3] ?? 0) & (1 << (pos & 7))) !== 0;
        out[dst + i] = valid ? (values[i] as number) : NaN;
      }
    }
    dst += len;
  }
  if (dst !== numRows) {
    throw new Error(`column has ${dst} rows, expected ${numRows}`);
  }
  return out;
}

/** Copy the Int64 time column into a dense BigInt64Array. The time column is
 *  declared non-nullable in the Arrow schema; if nulls appear anyway we error
 *  loudly rather than fabricate timestamps. */
export function extractTimeColumn(col: Vector, numRows: number): BigInt64Array {
  const out = new BigInt64Array(numRows);
  let dst = 0;
  for (const data of col.data) {
    if (data.nullCount !== 0) {
      throw new Error(
        `time_us column contains ${data.nullCount} null(s) — refusing to fabricate timestamps`,
      );
    }
    const len = data.length;
    if (dst + len > numRows) {
      throw new Error(`time column chunks exceed row count ${numRows}`);
    }
    const values = data.values as unknown as BigInt64Array;
    out.set(values.subarray(0, len), dst);
    dst += len;
  }
  if (dst !== numRows) {
    throw new Error(`time column has ${dst} rows, expected ${numRows}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Store loading
// ---------------------------------------------------------------------------

export interface LoadResult {
  warnings: string[];
  durationUs: number;
}

/** Decode an envelope buffer and add its rate groups to the store. Pure with
 *  respect to Tauri — unit-testable against a hand-built ArrayBuffer. */
export function applyEnvelopeToStore(store: ChannelStore, buffer: ArrayBuffer): LoadResult {
  const env = decodeEnvelope(buffer);
  for (const g of env.header.rate_groups) {
    const table = tableFromIPC(groupIpcBytes(env, g));
    const timeCol = table.getChild("time_us");
    if (!timeCol) throw new Error(`rate group ${g.id}: missing time_us column`);
    const time = extractTimeColumn(timeCol, table.numRows);

    const columns = new Map<string, Float64Array>();
    for (const meta of g.channel_metas) {
      const col = table.getChild(meta.id);
      if (!col) continue;
      columns.set(meta.id, extractFloat64Column(col, table.numRows));
    }
    store.addRateGroup(
      RateGroup.fromColumns({ id: g.id, nominalRateHz: g.nominal_rate_hz, time, columns }),
      g.channel_metas,
    );
  }
  return { warnings: env.header.warnings, durationUs: env.header.duration_us };
}

export async function loadCsvIntoStore(
  store: ChannelStore,
  csvPath: string,
  registryPath: string,
): Promise<LoadResult> {
  const buffer = await invoke<ArrayBuffer>("load_csv", {
    path: csvPath,
    registryPath,
  });
  return applyEnvelopeToStore(store, buffer);
}
