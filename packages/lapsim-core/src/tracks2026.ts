// The real 2026 FSAE competition courses, traced from the published course maps
// (see ./tracks/README.md for provenance). These are the production tracks the
// lap sim scores against — `computeEvents` defaults to them. The JSON files are
// serialized `RawTrack`s (a straight is `radius: null`); `parseTrack` normalizes
// each into a `Track` (null → Infinity).

import { parseTrack, type RawTrack, type Track } from "./track";
import { trackFromVisual } from "./trackGeometry";
import { AUTOCROSS_2026_VISUAL, ENDURANCE_2026_VISUAL } from "./tracksVisual2026";
import autocrossRaw from "./tracks/autocross-2026.json";
import enduranceRaw from "./tracks/endurance-2026.json";

// The sim tracks now DERIVE from the traced visual centerlines (Menger
// curvature, 6 m arc-length smoothing) instead of the hand-built
// constant-radius arc lists: the radius profile varies continuously like the
// real course, which killed the corner-speed plateaus ("RPM hangs": 25% of
// lap samples → ~0%), and the lap-distance → visual mapping in the UI is now
// exact (same centerline).
//
// LENGTH: the raw traces measure 685 m / 2.12 km — but the published map's
// scale is suspect, the rules say ~0.80 km autocross and ~22 km endurance
// (≈10 × 2.2 km laps, per Nick), and the physics agrees: at the rules
// lengths the anchor-solved LATERAL tire surface scale (0.659) lands next to
// the track-independent LONGITUDINAL one (0.70) — same tire, same asphalt —
// whereas the raw trace size forces an implausible 0.53 vs 0.70 split. So
// each course is uniformly rescaled (lengths AND radii) to rules-nominal.
// The legacy radius-segment versions remain exported for regression reference.

/** Autocross 2026 — point-to-point, 800 m (traced curvature, rules length). */
export const AUTOCROSS_2026: Track = trackFromVisual(AUTOCROSS_2026_VISUAL, {
  smoothM: 6,
  scaleToLength: 800,
});

/** Endurance 2026 — closed loop, 2.20 km/lap (traced curvature, rules length). */
export const ENDURANCE_2026: Track = trackFromVisual(ENDURANCE_2026_VISUAL, {
  smoothM: 6,
  scaleToLength: 2200,
});

/** Legacy hand-built radius-segment versions (pre-traced-curvature). */
export const AUTOCROSS_2026_RADIUS: Track = parseTrack(autocrossRaw as RawTrack);
export const ENDURANCE_2026_RADIUS: Track = parseTrack(enduranceRaw as RawTrack);
