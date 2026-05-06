# 20 — MoTeC ADL GPS columns came in as huge positive numbers

## Symptom

After enabling the basemap, the map opened at world view and stayed dark. With the silent try/catch around the MapLibre constructor stripped, the actual error appeared: `lat must be between -90 and 90`. The bbox computed from the loaded session had latitude values in the hundreds of millions.

## Root cause

The bundled MoTeC ADL exports (`driver-tryout-good-gps`, `sdm26-best-accel`) ship GPS as **signed int32 micro-degrees**, but MoTeC's CSV writer renders them as unsigned. ASU's longitude of −111.93° comes out as `"3175683584"` (= 4294967296 − 1119283712); latitude 33.43° shows as `"334295616"`. The CSV loader parses them as positive f64s and they sail straight through to the widget unconverted.

## Fix

Inside the GPS widget's `buildSessionRaws()`, decode any value past ±1000 as int32-stored-as-uint32 + 1e-7 scale:

```ts
const INT32_MAX = 2_147_483_647;
const UINT32_RANGE = 4_294_967_296;
function decodeGpsValue(v: number): number {
  if (!Number.isFinite(v) || Math.abs(v) <= 1000) return v;
  const signed = v > INT32_MAX ? v - UINT32_RANGE : v;
  return signed / 1e7;
}
```

`decodeGpsArray()` only allocates a new buffer when at least one value trips the threshold, so synthetic / well-formed feeds stay zero-copy. The decode runs *before* anything else looks at the values, so MapLibre projection, canvas projection, click/drag scrubbing, and the cursor dot all see clean degrees.

Also added a `bboxToBounds()` validator that returns `undefined` for any bbox whose lat/lon falls outside legal ranges, so MapLibre's constructor never sees illegal bounds and we surface a red "basemap can't frame" diagnostic on the canvas instead of crashing. (This caught the underlying problem above; before the validator it crashed silently and we saw nothing.)

## Files changed

- [packages/widgets/src/gps-track/render.tsx](../packages/widgets/src/gps-track/render.tsx)
