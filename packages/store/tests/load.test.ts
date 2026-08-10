import { describe, it, expect } from "vitest";
import {
  Float64,
  Int64,
  Table,
  makeVector,
  tableFromIPC,
  tableToIPC,
  vectorFromArray,
} from "apache-arrow";
import { ChannelStore } from "../src";
import {
  applyEnvelopeToStore,
  decodeEnvelope,
  extractFloat64Column,
  extractTimeColumn,
  groupIpcBytes,
} from "../src/load";
import type { EnvelopeHeader, RateGroupHeader } from "../src/load";
import type { ChannelMeta } from "../src/types";

const meta = (id: string): ChannelMeta => ({
  id, display_name: id, units: "", group: "test", color: "#fff",
  decimals: 2, data_type: "f64", source: "test", sample_rate_hz: 100,
});

/** Mirror of the Rust envelope writer: [u32 LE header_len][header JSON][blob]. */
function buildEnvelope(header: EnvelopeHeader, blob: Uint8Array): ArrayBuffer {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(4 + headerBytes.length + blob.length);
  new DataView(out.buffer).setUint32(0, headerBytes.length, true);
  out.set(headerBytes, 4);
  out.set(blob, 4 + headerBytes.length);
  return out.buffer;
}

const groupHeader = (
  id: string, ipc_offset: number, ipc_len: number, metas: ChannelMeta[] = [],
): RateGroupHeader => ({
  id, nominal_rate_hz: 100, channel_metas: metas, ipc_offset, ipc_len,
});

describe("decodeEnvelope", () => {
  it("parses header and exposes the blob with per-group subarray views", () => {
    const header: EnvelopeHeader = {
      rate_groups: [groupHeader("g1", 0, 3), groupHeader("g2", 3, 4)],
      warnings: ["w1"],
      duration_us: 42,
    };
    const blob = Uint8Array.from([1, 2, 3, 4, 5, 6, 7]);
    const buffer = buildEnvelope(header, blob);

    const env = decodeEnvelope(buffer);
    expect(env.header.warnings).toEqual(["w1"]);
    expect(env.header.duration_us).toBe(42);
    expect(env.header.rate_groups.map(g => g.id)).toEqual(["g1", "g2"]);
    expect(Array.from(env.blob)).toEqual([1, 2, 3, 4, 5, 6, 7]);

    const g1 = groupIpcBytes(env, env.header.rate_groups[0]!);
    const g2 = groupIpcBytes(env, env.header.rate_groups[1]!);
    expect(Array.from(g1)).toEqual([1, 2, 3]);
    expect(Array.from(g2)).toEqual([4, 5, 6, 7]);
    // Views, not copies: same underlying ArrayBuffer.
    expect(g1.buffer).toBe(buffer);
    expect(g2.buffer).toBe(buffer);
  });

  it("handles an empty blob (zero rate groups)", () => {
    const buffer = buildEnvelope({ rate_groups: [], warnings: [], duration_us: 0 }, new Uint8Array(0));
    const env = decodeEnvelope(buffer);
    expect(env.header.rate_groups).toEqual([]);
    expect(env.blob.byteLength).toBe(0);
  });

  it("rejects a buffer too short for the length prefix", () => {
    expect(() => decodeEnvelope(new Uint8Array([1, 2]).buffer)).toThrow(/too short/);
  });

  it("rejects a header_len that overruns the buffer", () => {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setUint32(0, 1000, true);
    expect(() => decodeEnvelope(out.buffer)).toThrow(/corrupt/);
  });

  it("rejects a group window that overruns the blob", () => {
    const header: EnvelopeHeader = {
      rate_groups: [groupHeader("g1", 0, 99)], warnings: [], duration_us: 0,
    };
    const env = decodeEnvelope(buildEnvelope(header, Uint8Array.from([1, 2, 3])));
    expect(() => groupIpcBytes(env, env.header.rate_groups[0]!)).toThrow(/corrupt/);
  });
});

describe("extractFloat64Column", () => {
  it("copies a null-free column exactly (fast path)", () => {
    const col = vectorFromArray([1.5, -2.5, 3.25, 0], new Float64());
    const out = extractFloat64Column(col, 4);
    expect(Array.from(out)).toEqual([1.5, -2.5, 3.25, 0]);
  });

  it("turns null cells into NaN, not 0", () => {
    const col = vectorFromArray([1.5, null, 2.5, null], new Float64());
    const out = extractFloat64Column(col, 4);
    expect(out[0]).toBe(1.5);
    expect(out[1]).toBeNaN();
    expect(out[2]).toBe(2.5);
    expect(out[3]).toBeNaN();
  });

  it("handles multi-chunk columns from a multi-batch IPC stream", () => {
    const t1 = new Table({ a: vectorFromArray([1, null, 3], new Float64()) });
    const t2 = new Table({ a: vectorFromArray([4, 5, null], new Float64()) });
    const table = tableFromIPC(tableToIPC(t1.concat(t2)));
    const col = table.getChild("a")!;
    expect(col.data.length).toBeGreaterThan(1); // really chunked
    const out = extractFloat64Column(col, table.numRows);
    expect(out[0]).toBe(1);
    expect(out[1]).toBeNaN();
    expect(out[2]).toBe(3);
    expect(out[3]).toBe(4);
    expect(out[4]).toBe(5);
    expect(out[5]).toBeNaN();
  });

  it("respects data.offset after a slice (validity bitmap bookkeeping)", () => {
    const table = new Table({
      a: vectorFromArray([null, 10, 20, null, 40, 50], new Float64()),
    }).slice(2, 6); // rows [20, null, 40, 50], chunk offset > 0
    const col = table.getChild("a")!;
    expect(col.data[0]!.offset).toBeGreaterThan(0);
    const out = extractFloat64Column(col, table.numRows);
    expect(out[0]).toBe(20);
    expect(out[1]).toBeNaN();
    expect(out[2]).toBe(40);
    expect(out[3]).toBe(50);
  });

  it("rejects a row-count mismatch", () => {
    const col = vectorFromArray([1, 2], new Float64());
    expect(() => extractFloat64Column(col, 3)).toThrow(/rows/);
  });
});

describe("extractTimeColumn", () => {
  it("copies Int64 values", () => {
    const col = makeVector(BigInt64Array.from([0n, 10_000n, 20_000n]));
    const out = extractTimeColumn(col, 3);
    expect(Array.from(out)).toEqual([0n, 10_000n, 20_000n]);
  });

  it("errors loudly on null timestamps instead of fabricating them", () => {
    const col = vectorFromArray([0n, null, 20_000n], new Int64());
    expect(() => extractTimeColumn(col, 3)).toThrow(/null/);
  });
});

describe("applyEnvelopeToStore", () => {
  it("loads rate groups from a real Arrow IPC envelope into the store", () => {
    // Group 1: 100hz, rpm has a null that must surface as NaN.
    const ipc1 = tableToIPC(new Table({
      time_us: makeVector(BigInt64Array.from([0n, 10_000n, 20_000n])),
      "engine.rpm": vectorFromArray([1000, null, 3000], new Float64()),
    }));
    // Group 2: 10hz, no nulls.
    const ipc2 = tableToIPC(new Table({
      time_us: makeVector(BigInt64Array.from([0n, 100_000n])),
      "engine.water_temp": vectorFromArray([88, 89], new Float64()),
    }));
    const blob = new Uint8Array(ipc1.length + ipc2.length);
    blob.set(ipc1, 0);
    blob.set(ipc2, ipc1.length);
    const header: EnvelopeHeader = {
      rate_groups: [
        { id: "100hz", nominal_rate_hz: 100, channel_metas: [meta("engine.rpm")], ipc_offset: 0, ipc_len: ipc1.length },
        { id: "10hz", nominal_rate_hz: 10, channel_metas: [meta("engine.water_temp")], ipc_offset: ipc1.length, ipc_len: ipc2.length },
      ],
      warnings: ["minor thing"],
      duration_us: 1234,
    };

    const store = new ChannelStore();
    const result = applyEnvelopeToStore(store, buildEnvelope(header, blob));

    expect(result.warnings).toEqual(["minor thing"]);
    expect(result.durationUs).toBe(1234);
    expect(store.groups().map(g => g.id).sort()).toEqual(["100hz", "10hz"]);

    const g100 = store.groupOf("engine.rpm")!;
    expect(Array.from(g100.time)).toEqual([0n, 10_000n, 20_000n]);
    const rpm = g100.data("engine.rpm");
    expect(rpm[0]).toBe(1000);
    expect(rpm[1]).toBeNaN(); // null → NaN, never 0
    expect(rpm[2]).toBe(3000);

    const g10 = store.groupOf("engine.water_temp")!;
    expect(g10.nominalRateHz).toBe(10);
    expect(Array.from(g10.data("engine.water_temp"))).toEqual([88, 89]);
  });

  it("throws when a group's time_us column is missing", () => {
    const ipc = tableToIPC(new Table({
      "engine.rpm": vectorFromArray([1, 2], new Float64()),
    }));
    const header: EnvelopeHeader = {
      rate_groups: [
        { id: "g", nominal_rate_hz: 100, channel_metas: [meta("engine.rpm")], ipc_offset: 0, ipc_len: ipc.length },
      ],
      warnings: [],
      duration_us: 0,
    };
    const buffer = buildEnvelope(header, new Uint8Array(ipc));
    expect(() => applyEnvelopeToStore(new ChannelStore(), buffer)).toThrow(/time_us/);
  });
});
