/**
 * HTP/1 — Helios Telemetry Protocol v1 — frame decoding.
 *
 * Wire layout (POST body, binary, little-endian unless noted):
 *
 *   Header, 36 bytes:
 *     offset  0  magic              u16  = 0x4854
 *     offset  2  version            u8   = 1
 *     offset  3  flags              u8   (bit0 reserved, must be 0)
 *     offset  4  session_id         16 bytes (RFC 4122 byte order, i.e. big-endian textual order)
 *     offset 20  channel_set_id     u16
 *     offset 22  group_key          u8
 *     offset 23  window_count       u8   (1..=8)
 *     offset 24  seq                u32  (seq of the FIRST window; windows are consecutive seqs)
 *     offset 28  send_timestamp_ms  u64
 *
 *   Then window_count windows, each:
 *     t_start_us  u64 (absolute unix microseconds; window length is exactly 1 second)
 *     then for each channel of the set's group, in registered order, rate_hz samples:
 *       enc = f32   -> IEEE 754 float32 LE (4 bytes/sample)
 *       enc = i16fp -> int16 LE, decoded = raw * scale + offset (2 bytes/sample)
 *
 * Payload size is fully deterministic from the channel set definition; the
 * total body length must match exactly.
 */

export const HTP_MAGIC = 0x4854;
export const HTP_VERSION = 1;
export const HEADER_BYTES = 36;
export const MAX_WINDOWS = 8;

export type ChannelEncoding = "f32" | "i16fp";

export interface ChannelDef {
  id: string;
  rate_hz: number;
  enc: ChannelEncoding;
  /** i16fp only; defaults to 1 */
  scale?: number;
  /** i16fp only; defaults to 0 */
  offset?: number;
}

export interface ChannelGroup {
  channels: ChannelDef[];
}

/** Shape of telemetry.channel_sets.definition (jsonb). */
export interface ChannelSetDefinition {
  groups: Record<string, ChannelGroup>;
}

/** Client-caused decode/validation failure -> HTTP 400. */
export class FrameError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "FrameError";
  }
}

/** Invalid server-side channel set registration -> HTTP 500. */
export class DefinitionError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "DefinitionError";
  }
}

export interface FrameHeader {
  flags: number;
  sessionId: string;
  channelSetId: number;
  groupKey: number;
  windowCount: number;
  firstSeq: number;
  sendTimestampMs: number;
}

export interface DecodedWindow {
  tStartUs: bigint;
  /** channel id -> rate_hz decoded samples (already scaled for i16fp) */
  samples: Record<string, Float64Array>;
}

export interface DecodedFrame extends FrameHeader {
  windows: DecodedWindow[];
}

const SAMPLE_BYTES: Record<ChannelEncoding, number> = { f32: 4, i16fp: 2 };

/**
 * Validates the group and returns its uniform sample rate.
 * Groups must contain only channels of equal rate_hz (mixed rates rejected).
 */
export function groupRateHz(group: ChannelGroup): number {
  if (!Array.isArray(group.channels) || group.channels.length === 0) {
    throw new DefinitionError("channel group has no channels");
  }
  const rate = group.channels[0].rate_hz;
  const seen = new Set<string>();
  for (const ch of group.channels) {
    if (typeof ch.id !== "string" || ch.id.length === 0) {
      throw new DefinitionError("channel with missing/empty id");
    }
    if (seen.has(ch.id)) {
      throw new DefinitionError(`duplicate channel id "${ch.id}" in group`);
    }
    seen.add(ch.id);
    if (!Number.isInteger(ch.rate_hz) || ch.rate_hz < 1) {
      throw new DefinitionError(`channel "${ch.id}" has invalid rate_hz ${ch.rate_hz}`);
    }
    if (ch.rate_hz !== rate) {
      throw new DefinitionError(
        `mixed rate_hz within one group ("${ch.id}" is ${ch.rate_hz} Hz, group is ${rate} Hz)`,
      );
    }
    if (ch.enc !== "f32" && ch.enc !== "i16fp") {
      throw new DefinitionError(`channel "${ch.id}" has unknown encoding "${ch.enc}"`);
    }
  }
  return rate;
}

/** Exact encoded size of one window for this group. */
export function bytesPerWindow(group: ChannelGroup): number {
  let n = 8; // t_start_us
  for (const ch of group.channels) {
    n += ch.rate_hz * SAMPLE_BYTES[ch.enc];
  }
  return n;
}

export function parseHeader(bytes: Uint8Array): FrameHeader {
  if (bytes.byteLength < HEADER_BYTES) {
    throw new FrameError(
      `frame too short: ${bytes.byteLength} bytes, header is ${HEADER_BYTES}`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const magic = view.getUint16(0, true);
  if (magic !== HTP_MAGIC) {
    throw new FrameError(
      `bad magic 0x${magic.toString(16).padStart(4, "0")}, expected 0x4854`,
    );
  }
  const version = view.getUint8(2);
  if (version !== HTP_VERSION) {
    throw new FrameError(`unsupported version ${version}, expected ${HTP_VERSION}`);
  }
  const flags = view.getUint8(3);
  if ((flags & 0x01) !== 0) {
    throw new FrameError("reserved flag bit0 is set");
  }

  const sessionId = formatUuid(bytes.subarray(4, 20));
  const channelSetId = view.getUint16(20, true);
  const groupKey = view.getUint8(22);
  const windowCount = view.getUint8(23);
  if (windowCount < 1 || windowCount > MAX_WINDOWS) {
    throw new FrameError(`window_count ${windowCount} out of range 1..${MAX_WINDOWS}`);
  }
  const firstSeq = view.getUint32(24, true);
  const sendTimestampMs = Number(view.getBigUint64(28, true));

  return { flags, sessionId, channelSetId, groupKey, windowCount, firstSeq, sendTimestampMs };
}

/**
 * Full binary decode. The caller resolves `def` from telemetry.channel_sets
 * using parseHeader(bytes).channelSetId first.
 */
export function decodeFrame(bytes: Uint8Array, def: ChannelSetDefinition): DecodedFrame {
  const header = parseHeader(bytes);

  const group = def.groups?.[String(header.groupKey)];
  if (!group) {
    throw new FrameError(
      `unknown group_key ${header.groupKey} for channel_set ${header.channelSetId}`,
    );
  }
  groupRateHz(group); // validates the registered definition

  const expected = HEADER_BYTES + header.windowCount * bytesPerWindow(group);
  if (bytes.byteLength !== expected) {
    throw new FrameError(
      `payload length mismatch: got ${bytes.byteLength} bytes, expected ${expected} ` +
        `(${header.windowCount} window(s) of ${bytesPerWindow(group)} bytes)`,
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = HEADER_BYTES;
  const windows: DecodedWindow[] = [];

  for (let w = 0; w < header.windowCount; w++) {
    const tStartUs = view.getBigUint64(off, true);
    off += 8;
    const samples: Record<string, Float64Array> = {};
    for (const ch of group.channels) {
      const out = new Float64Array(ch.rate_hz);
      if (ch.enc === "f32") {
        for (let i = 0; i < ch.rate_hz; i++) {
          out[i] = view.getFloat32(off, true);
          off += 4;
        }
      } else {
        const scale = ch.scale ?? 1;
        const offset = ch.offset ?? 0;
        for (let i = 0; i < ch.rate_hz; i++) {
          out[i] = view.getInt16(off, true) * scale + offset;
          off += 2;
        }
      }
      samples[ch.id] = out;
    }
    windows.push({ tStartUs, samples });
  }

  return { ...header, windows };
}

// ---------------------------------------------------------------------------
// JSON fallback (Content-Type: application/json), same semantics as binary:
// { session_id, channel_set_id, group_key, seq, send_timestamp_ms,
//   windows: [{ t_start_us, samples: { [channel_id]: number[] } }] }
// ---------------------------------------------------------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Extract channel_set_id from a parsed JSON body before the definition is loaded. */
export function peekJsonChannelSetId(raw: unknown): number {
  const id = (raw as { channel_set_id?: unknown })?.channel_set_id;
  if (!Number.isInteger(id) || (id as number) < 0 || (id as number) > 0xffff) {
    throw new FrameError("channel_set_id must be an integer in 0..65535");
  }
  return id as number;
}

export function decodeJsonFrame(raw: unknown, def: ChannelSetDefinition): DecodedFrame {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new FrameError("body must be a JSON object");
  }
  const o = raw as Record<string, unknown>;

  if (typeof o.session_id !== "string" || !UUID_RE.test(o.session_id)) {
    throw new FrameError("session_id must be a UUID string");
  }
  const channelSetId = peekJsonChannelSetId(o);
  if (!Number.isInteger(o.group_key) || (o.group_key as number) < 0 || (o.group_key as number) > 0xff) {
    throw new FrameError("group_key must be an integer in 0..255");
  }
  const groupKey = o.group_key as number;
  if (!Number.isInteger(o.seq) || (o.seq as number) < 0 || (o.seq as number) > 0xffffffff) {
    throw new FrameError("seq must be an integer in 0..2^32-1");
  }
  if (typeof o.send_timestamp_ms !== "number" || !Number.isFinite(o.send_timestamp_ms)) {
    throw new FrameError("send_timestamp_ms must be a finite number");
  }
  if (!Array.isArray(o.windows) || o.windows.length < 1 || o.windows.length > MAX_WINDOWS) {
    throw new FrameError(`windows must be an array of 1..${MAX_WINDOWS} windows`);
  }

  const group = def.groups?.[String(groupKey)];
  if (!group) {
    throw new FrameError(`unknown group_key ${groupKey} for channel_set ${channelSetId}`);
  }
  const rateHz = groupRateHz(group);
  const channelIds = new Set(group.channels.map((c) => c.id));

  const windows: DecodedWindow[] = o.windows.map((w: unknown, idx: number) => {
    if (typeof w !== "object" || w === null) {
      throw new FrameError(`windows[${idx}] must be an object`);
    }
    const win = w as Record<string, unknown>;
    if (
      typeof win.t_start_us !== "number" || !Number.isFinite(win.t_start_us) ||
      win.t_start_us < 0 || !Number.isInteger(win.t_start_us)
    ) {
      throw new FrameError(`windows[${idx}].t_start_us must be a non-negative integer`);
    }
    const samplesIn = win.samples;
    if (typeof samplesIn !== "object" || samplesIn === null || Array.isArray(samplesIn)) {
      throw new FrameError(`windows[${idx}].samples must be an object`);
    }
    for (const key of Object.keys(samplesIn)) {
      if (!channelIds.has(key)) {
        throw new FrameError(`windows[${idx}].samples has unknown channel "${key}"`);
      }
    }
    const samples: Record<string, Float64Array> = {};
    for (const ch of group.channels) {
      const arr = (samplesIn as Record<string, unknown>)[ch.id];
      if (!Array.isArray(arr) || arr.length !== rateHz) {
        throw new FrameError(
          `windows[${idx}].samples["${ch.id}"] must be an array of exactly ${rateHz} numbers`,
        );
      }
      const out = new Float64Array(rateHz);
      for (let i = 0; i < rateHz; i++) {
        const v = arr[i];
        if (typeof v !== "number" || !Number.isFinite(v)) {
          throw new FrameError(`windows[${idx}].samples["${ch.id}"][${i}] is not a finite number`);
        }
        out[i] = v;
      }
      samples[ch.id] = out;
    }
    return { tStartUs: BigInt(win.t_start_us as number), samples };
  });

  return {
    flags: 0,
    sessionId: (o.session_id as string).toLowerCase(),
    channelSetId,
    groupKey,
    windowCount: windows.length,
    firstSeq: o.seq as number,
    sendTimestampMs: o.send_timestamp_ms as number,
    windows,
  };
}

function formatUuid(b: Uint8Array): string {
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
