import { resolveResource } from "@tauri-apps/api/path";
import { ChannelStore, loadCsvIntoStore } from "@helios/store";

export interface SampleEntry { id: string; label: string; resource: string; }

export const SAMPLES: SampleEntry[] = [
  { id: "driver-tryout-good-gps", label: "Driver tryout 4/16 — Kaden (good GPS)", resource: "samples/driver-tryout-good-gps.csv" },
  { id: "sdm26-best-accel",       label: "SDM26 5/3 — Best Accel",                resource: "samples/sdm26-best-accel.csv" },
  { id: "sdm26-synthetic",        label: "SDM26 synthetic lap (demo)",            resource: "samples/sdm26-synthetic-lap.csv" },
];

export async function loadSampleSession(resourceRelPath: string = SAMPLES[0]!.resource): Promise<ChannelStore> {
  const store = new ChannelStore();
  const csv = await resolveResource(resourceRelPath);
  const yaml = await resolveResource("channels.yaml");
  await loadCsvIntoStore(store, csv, yaml);
  return store;
}
