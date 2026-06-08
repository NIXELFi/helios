# 2026 competition tracks

Real FSAE 2026 course geometry used by the lap sim (`computeEvents`), replacing
the rules-synthesized placeholders.

- `autocross-2026.json` — Autocross 2026, point-to-point (`closed: false`),
  ~738 m, 39 segments.
- `endurance-2026.json` — Endurance 2026, closed loop (`closed: true`),
  ~2.30 km/lap, 61 segments.

## Format

Each file is a serialized `Track` (see `../track.ts`): `{ name, closed,
segments: [{ length, radius }] }`. Lengths and radii are metres. `radius: null`
marks a straight; `parseTrack()` maps it to `Infinity`. Corner direction is
omitted — only the radius profile matters to the point-mass QSS sim.

## Provenance

Traced from the published 2026 course maps. Source originals (overlay PNGs +
`_flags.json` QA notes flagging gentle sweepers and clamped radii) live in
`Documents/Vault/SDM27/Helios/2026 Competition Tracks`. These vendored copies
are the version-controlled source of truth for the model.
