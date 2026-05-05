# 06 — In-app sample switcher for bundled CSVs

## Symptom

A second real session — `driver_tryout_4_16__57_kaden_good_gps.csv` — was added to the repo root. The previous flow only loaded one CSV at startup, so to inspect a different file the source had to be edited and the app rebuilt.

## Root cause

`apps/desktop/src/App.tsx` called `loadSampleSession()` exactly once on mount, with the CSV resource path hard-coded inside [load-sample.ts](../apps/desktop/src/lib/load-sample.ts). There was no way to pick a different file from the running app, and the bundle config only listed one real CSV.

## Fix

### 1. Bundle both CSVs as Tauri resources

[apps/desktop/src-tauri/tauri.conf.json](../apps/desktop/src-tauri/tauri.conf.json) now includes the new file alongside the existing two:

```jsonc
"resources": {
  "../../../samples/sdm26-synthetic-lap.csv":           "samples/sdm26-synthetic-lap.csv",
  "../../../SDM26-5-3-Best_Accel.csv":                  "samples/sdm26-best-accel.csv",
  "../../../driver_tryout_4_16__57_kaden_good_gps.csv": "samples/driver-tryout-good-gps.csv",
  ...
}
```

### 2. Promote the loader to a registry of samples

[load-sample.ts](../apps/desktop/src/lib/load-sample.ts) now exports a `SAMPLES` array describing every bundled CSV (id, human label, resource path). `loadSampleSession()` takes the resource path as an argument and defaults to the first entry. Adding a new sample is now one entry in this array plus one entry in the Tauri resource map.

### 3. Sample selector in the header

[App.tsx](../apps/desktop/src/App.tsx) now keeps the chosen `sampleId` in state and rebuilds the store whenever it changes. A small `<select>` in the header lets the user pick between bundled samples without restarting the app.

```tsx
const [sampleId, setSampleId] = useState(SAMPLES[0]!.id);
useEffect(() => {
  setStore(null);
  loadSampleSession(SAMPLES.find(s => s.id === sampleId)!.resource).then(setStore)…
}, [sampleId]);
```

The store is reset between switches, so widgets remount fresh against the new data. The cursor emitter is preserved (it just resets its `last` time when the new file's first emit arrives).

## Caveats / known issues

- **GPS scaling.** The new file (`driver-tryout-good-gps.csv`) DOES have valid GPS data, but stored as int-microdegrees (e.g. `334295616` = 33.4295616 °N, `3175683584` interpreted as signed int32 = -111.93 °W). The GPS plot will show motion proportionally — the relative shape of the lap is correct — but absolute coordinates won't match a real-world map until we add a per-channel decode/scale step. Tracked as future work; current widgets only do min/max normalization so this doesn't break anything visually.
- **Sample rate difference.** This CSV is at 100 Hz (vs. 1000 Hz for the accel file), so the strip-chart density will look noticeably coarser. The MoTeC preprocessor handles both rates without code changes.

## Files changed

- [apps/desktop/src-tauri/tauri.conf.json](../apps/desktop/src-tauri/tauri.conf.json)
- [apps/desktop/src/lib/load-sample.ts](../apps/desktop/src/lib/load-sample.ts)
- [apps/desktop/src/App.tsx](../apps/desktop/src/App.tsx)
