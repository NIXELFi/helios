/**
 * Transcoding of one decoded HTP window into a single Arrow IPC *stream*
 * record batch, decodable by plain web clients with apache-arrow JS
 * (tableFromIPC).
 *
 * Schema: time_us int64 (not null), then one float64 (nullable) column per
 * channel id, in registered order. Because every channel in a group shares
 * one rate_hz, all columns sit on the same time grid.
 */

import {
  Field,
  Float64,
  Int64,
  RecordBatch,
  Schema,
  Struct,
  Table,
  type Data,
  makeData,
  makeVector,
  tableToIPC,
} from "npm:apache-arrow@17.0.0";

/**
 * time_us[i] = t_start_us + round(i * 1_000_000 / rate_hz).
 * Rounded per sample so rates that do not divide 1e6 stay drift-free
 * across the window.
 */
export function buildTimeColumnUs(tStartUs: bigint, rateHz: number): BigInt64Array {
  const out = new BigInt64Array(rateHz);
  for (let i = 0; i < rateHz; i++) {
    out[i] = tStartUs + BigInt(Math.round((i * 1_000_000) / rateHz));
  }
  return out;
}

/**
 * Builds the IPC stream bytes for one window.
 * `values` must be in the same order as `channelIds`, each with
 * `timeUs.length` samples.
 */
export function windowToArrowIPC(
  channelIds: string[],
  timeUs: BigInt64Array,
  values: Float64Array[],
): Uint8Array {
  if (values.length !== channelIds.length) {
    throw new Error("channelIds/values length mismatch");
  }
  const length = timeUs.length;
  for (const v of values) {
    if (v.length !== length) throw new Error("column length mismatch");
  }

  const fields = [
    new Field("time_us", new Int64(), /* nullable */ false),
    ...channelIds.map((id) => new Field(id, new Float64(), /* nullable */ true)),
  ];
  const schema = new Schema(fields);

  const children: Data[] = [
    makeVector(timeUs).data[0] as Data,
    ...values.map((v) => makeVector(v).data[0] as Data),
  ];
  const structData = makeData({
    type: new Struct(fields),
    length,
    nullCount: 0,
    children,
  });

  const table = new Table(schema, new RecordBatch(schema, structData));
  return tableToIPC(table, "stream");
}
