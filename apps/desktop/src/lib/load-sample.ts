import { resolveResource } from "@tauri-apps/api/path";
import { ChannelStore, loadCsvIntoStore } from "@helios/store";

export async function loadSampleSession(): Promise<ChannelStore> {
  const store = new ChannelStore();
  const csv = await resolveResource("samples/sdm26-synthetic-lap.csv");
  const yaml = await resolveResource("channels.yaml");
  await loadCsvIntoStore(store, csv, yaml);
  return store;
}
