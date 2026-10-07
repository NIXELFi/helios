import { describe, expect, it } from "vitest";
import {
  decodeFrame,
  type ChannelDef,
} from "../../../infra/telemetry-supabase/supabase/functions/telemetry-ingest/frame";

// Exercise the edge function's pure decoder in the existing Vitest CI suite.
function decodeSamples(channel: ChannelDef, raw: number[]): Float64Array {
  const width = channel.enc === "i16fp" ? 2 : 4;
  const bytes = new Uint8Array(36 + 8 + raw.length * width);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0x4854, true);
  view.setUint8(2, 1);
  view.setUint16(20, 1, true);
  view.setUint8(23, 1);
  view.setBigUint64(36, 1_000_000n, true);
  raw.forEach((value, i) => {
    if (channel.enc === "i16fp") view.setInt16(44 + i * width, value, true);
    else view.setFloat32(44 + i * width, value, true);
  });
  return decodeFrame(bytes, {
    groups: { "0": { rate_hz: raw.length, channels: [channel] } },
  }).windows[0].samples[channel.id];
}

describe("HTP missing samples", () => {
  it.each([
    { scale: 0.5, offset: 0 },
    { scale: 0.25, offset: -40 },
    {},
  ])("decodes INT16_MIN as NaN before applying %j", (scaling) => {
    const samples = decodeSamples({ id: "rpm", enc: "i16fp", ...scaling }, [-32768]);
    expect(samples[0]).toBeNaN();
  });

  it("preserves valid fixed-point values adjacent to the sentinel", () => {
    const samples = decodeSamples(
      { id: "rpm", enc: "i16fp", scale: 0.5, offset: 10 },
      [-32767, 0, 32767],
    );
    expect(Array.from(samples)).toEqual([-16373.5, 10, 16393.5]);
  });

  it("preserves f32 missing samples alongside real readings", () => {
    const samples = decodeSamples({ id: "speed", enc: "f32" }, [NaN, 12.5]);
    expect(samples[0]).toBeNaN();
    expect(samples[1]).toBe(12.5);
  });
});
