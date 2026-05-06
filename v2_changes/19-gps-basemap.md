# 19 — GPS basemap (toggleable real map under the track)

## Want

The bare polyline-on-dark canvas was useful for shape but not for context — there was no way to tell a Karsten course pad apart from a parking lot from the GPS view alone. Wanted MoTeC i2-style imagery underneath the trace.

## Fix

MapLibre GL JS layered under the existing canvas, with the track + cursor still drawn on the canvas overlay. Three modes via the GPS widget config (`basemap`):

- `none` — original dark canvas + normalized [0,1]² projection.
- `dark` — CARTO Dark Matter raster tiles. Free, no key.
- `satellite` — Esri World Imagery. Free, no key.
- `custom` — caller-supplied `{z}/{x}/{y}` URL template.

When a basemap is active, lat/lon project through `map.project()` so the polyline + cursor land on real-world coords. When `none`, the original projection runs unchanged (zero behavior change for existing workspaces).

The basemap is **read-only** — `interactive: false` on the MapLibre Map. The canvas overlay sits on top with `pointer-events-auto`, so click/drag scrubbing works exactly the same with or without a basemap.

`maxZoom: 18` on the Map and in `fitBoundsOptions` — FSAE tracks are ~90 m across, which fitBounds would otherwise push past z21+, beyond every tile source's maxzoom and leaving a dark map.

## Files changed

- [packages/widgets/src/gps-track/render.tsx](../packages/widgets/src/gps-track/render.tsx)
- [packages/widgets/src/gps-track/config-editor.tsx](../packages/widgets/src/gps-track/config-editor.tsx)
- [packages/widgets/package.json](../packages/widgets/package.json) — adds `maplibre-gl`
- [packages/widgets/tests/setup.ts](../packages/widgets/tests/setup.ts) — `vi.mock("maplibre-gl", …)` because MapLibre touches WebGL globals at module import time and jsdom can't satisfy that.
