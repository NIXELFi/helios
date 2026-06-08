// The real 2026 FSAE competition courses, traced from the published course maps
// (see ./tracks/README.md for provenance). These are the production tracks the
// lap sim scores against — `computeEvents` defaults to them. The JSON files are
// serialized `RawTrack`s (a straight is `radius: null`); `parseTrack` normalizes
// each into a `Track` (null → Infinity).

import { parseTrack, type RawTrack, type Track } from "./track";
import autocrossRaw from "./tracks/autocross-2026.json";
import enduranceRaw from "./tracks/endurance-2026.json";

/** Autocross 2026 — point-to-point, ~738 m. */
export const AUTOCROSS_2026: Track = parseTrack(autocrossRaw as RawTrack);

/** Endurance 2026 — closed loop, ~2.30 km/lap. */
export const ENDURANCE_2026: Track = parseTrack(enduranceRaw as RawTrack);
