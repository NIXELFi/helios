/**
 * Pure decode tests for frame.ts — no network, no Supabase.
 * Run: deno test frame_test.ts
 */

import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  type ChannelSetDefinition,
  DefinitionError,
  FrameError,
  HEADER_BYTES,
  decodeFrame,
  parseHeader,
} from "./frame.ts";

// ---------------------------------------------------------------------------
// Tiny HTP/1 encoder (test-only).
// ---------------------------------------------------------------------------

interface EncodedChannel {
  enc: "f32" | "i16fp";
  /** f32: float values; i16fp: RAW int16 values (pre-scale) */
  data: number[];
}

interface EncodeArgs {
  magic?: number;
  version?: number;
  flags?: number;
  sessionId: string;
  channelSetId: number;
  groupKey: number;
  firstSeq: number;
  sendTimestampMs: bigint;
  windows: { tStartUs: bigint; channels: EncodedChannel[] }[];
}

function encodeFrame(args: EncodeArgs): Uint8Array {
  let size = HEADER_BYTES;
  for (const w of args.windows) {
    size += 8;
    for (const ch of w.channels) {
      size += ch.data.length * (ch.enc === "f32" ? 4 : 2);
    }
  }

  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);

  view.setUint16(0, args.magic ?? 0x4854, true);
  view.setUint8(2, args.version ?? 1);
  view.setUint8(3, args.flags ?? 0);
  bytes.set(uuidToBytes(args.sessionId), 4);
  view.setUint16(20, args.channelSetId, true);
  view.setUint8(22, args.groupKey);
  view.setUint8(23, args.windows.length);
  view.setUint32(24, args.firstSeq, true);
  view.setBigUint64(28, args.sendTimestampMs, true);

  let off = HEADER_BYTES;
  for (const w of args.windows) {
    view.setBigUint64(off, w.tStartUs, true);
    off += 8;
    for (const ch of w.channels) {
      for (const v of ch.data) {
        if (ch.enc === "f32") {
          view.setFloat32(off, v, true);
          off += 4;
        } else {
          view.setInt16(off, v, true);
          off += 2;
        }
      }
    }
  }
  return bytes;
}

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const SCALE = 0.1;
const OFFSET = -40;

const DEF: ChannelSetDefinition = {
  groups: {
    "3": {
      channels: [
        { id: "rpm", rate_hz: 4, enc: "f32" },
        { id: "coolant_c", rate_hz: 4, enc: "i16fp", scale: SCALE, offset: OFFSET },
      ],
    },
  },
};

// f32-exact values so round-trip equality is exact.
const RPM_W0 = [1.5, 2.25, -3.5, 1000];
const RPM_W1 = [0, 0.125, 8192, -0.5];
// Raw int16 values for the i16fp channel.
const COOLANT_RAW_W0 = [0, 100, -200, 1234];
const COOLANT_RAW_W1 = [32767, -32768, 1, -1];

function goodFrame(): Uint8Array {
  return encodeFrame({
    sessionId: SESSION_ID,
    channelSetId: 7,
    groupKey: 3,
    firstSeq: 41,
    sendTimestampMs: 1765432100123n,
    windows: [
      {
        tStartUs: 1765432100000000n,
        channels: [
          { enc: "f32", data: RPM_W0 },
          { enc: "i16fp", data: COOLANT_RAW_W0 },
        ],
      },
      {
        tStartUs: 1765432101000000n,
        channels: [
          { enc: "f32", data: RPM_W1 },
          { enc: "i16fp", data: COOLANT_RAW_W1 },
        ],
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("decodeFrame round-trips header fields and f32/i16fp samples", () => {
  const frame = decodeFrame(goodFrame(), DEF);

  assertEquals(frame.sessionId, SESSION_ID);
  assertEquals(frame.channelSetId, 7);
  assertEquals(frame.groupKey, 3);
  assertEquals(frame.windowCount, 2);
  assertEquals(frame.firstSeq, 41);
  assertEquals(frame.sendTimestampMs, 1765432100123);
  assertEquals(frame.flags, 0);
  assertEquals(frame.windows.length, 2);

  assertEquals(frame.windows[0].tStartUs, 1765432100000000n);
  assertEquals(frame.windows[1].tStartUs, 1765432101000000n);

  assertEquals(Array.from(frame.windows[0].samples.rpm), RPM_W0);
  assertEquals(Array.from(frame.windows[1].samples.rpm), RPM_W1);
  assertEquals(
    Array.from(frame.windows[0].samples.coolant_c),
    COOLANT_RAW_W0.map((raw) => raw * SCALE + OFFSET),
  );
  assertEquals(
    Array.from(frame.windows[1].samples.coolant_c),
    COOLANT_RAW_W1.map((raw) => raw * SCALE + OFFSET),
  );
});

Deno.test("payload length mismatch (truncated) is rejected", () => {
  const bytes = goodFrame();
  assertThrows(
    () => decodeFrame(bytes.subarray(0, bytes.length - 1), DEF),
    FrameError,
    "length mismatch",
  );
});

Deno.test("payload length mismatch (trailing bytes) is rejected", () => {
  const bytes = goodFrame();
  const padded = new Uint8Array(bytes.length + 3);
  padded.set(bytes);
  assertThrows(() => decodeFrame(padded, DEF), FrameError, "length mismatch");
});

Deno.test("bad magic is rejected", () => {
  const bytes = goodFrame();
  bytes[0] = 0x00;
  assertThrows(() => decodeFrame(bytes, DEF), FrameError, "magic");
});

Deno.test("bad version is rejected", () => {
  const bytes = goodFrame();
  bytes[2] = 2;
  assertThrows(() => decodeFrame(bytes, DEF), FrameError, "version");
});

Deno.test("reserved flag bit0 is rejected", () => {
  const bytes = goodFrame();
  bytes[3] = 0x01;
  assertThrows(() => decodeFrame(bytes, DEF), FrameError, "bit0");
});

Deno.test("window_count of 0 is rejected", () => {
  const bytes = goodFrame();
  bytes[23] = 0;
  assertThrows(() => parseHeader(bytes), FrameError, "window_count");
});

Deno.test("window_count above 8 is rejected", () => {
  const bytes = goodFrame();
  bytes[23] = 9;
  assertThrows(() => parseHeader(bytes), FrameError, "window_count");
});

Deno.test("unknown group_key is rejected", () => {
  const bytes = goodFrame();
  bytes[22] = 5; // group "5" not in DEF
  assertThrows(() => decodeFrame(bytes, DEF), FrameError, "group_key");
});

Deno.test("mixed-rate group definition is rejected", () => {
  const mixed: ChannelSetDefinition = {
    groups: {
      "3": {
        channels: [
          { id: "a", rate_hz: 4, enc: "f32" },
          { id: "b", rate_hz: 10, enc: "f32" },
        ],
      },
    },
  };
  assertThrows(() => decodeFrame(goodFrame(), mixed), DefinitionError, "mixed rate_hz");
});
