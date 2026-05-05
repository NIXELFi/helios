import { invoke } from "@tauri-apps/api/core";
import { tableFromIPC } from "apache-arrow";
import { ChannelStore } from "./channel-store";
import { RateGroup } from "./rate-group";
import type { ChannelMeta } from "./types";

interface LoadedRateGroupRaw {
  id: string;
  nominal_rate_hz: number;
  channel_metas: ChannelMeta[];
  ipc: number[];
}
interface LoadCsvResponseRaw {
  rate_groups: LoadedRateGroupRaw[];
  warnings: string[];
  duration_us: number;
}

export interface LoadResult {
  warnings: string[];
  durationUs: number;
}

export async function loadCsvIntoStore(
  store: ChannelStore,
  csvPath: string,
  registryPath: string,
): Promise<LoadResult> {
  const resp = await invoke<LoadCsvResponseRaw>("load_csv", {
    path: csvPath,
    registryPath,
  });
  for (const rg of resp.rate_groups) {
    const bytes = new Uint8Array(rg.ipc);
    const table = tableFromIPC(bytes);
    const timeCol = table.getChild("time_us")!;
    const time = new BigInt64Array(table.numRows);
    for (let i = 0; i < table.numRows; i++) time[i] = timeCol.get(i) as bigint;

    const columns = new Map<string, Float64Array>();
    for (const meta of rg.channel_metas) {
      const col = table.getChild(meta.id);
      if (!col) continue;
      const arr = new Float64Array(table.numRows);
      for (let i = 0; i < table.numRows; i++) arr[i] = col.get(i) as number;
      columns.set(meta.id, arr);
    }
    store.addRateGroup(
      RateGroup.fromColumns({ id: rg.id, nominalRateHz: rg.nominal_rate_hz, time, columns }),
      rg.channel_metas,
    );
  }
  return { warnings: resp.warnings, durationUs: resp.duration_us };
}
