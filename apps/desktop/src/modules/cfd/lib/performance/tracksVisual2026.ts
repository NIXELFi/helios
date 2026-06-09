// High-fidelity traced 2026 course outlines for VISUAL rendering only ("not for
// timing"). These carry the real (x, y) centerline + left/right edges, so the
// track overview can draw the true layout — unlike the radius-segment tracks in
// tracks2026.ts, which the lap sim integrates (and which omit turn direction).

import { parseVisualTrack, type RawVisualTrack, type VisualTrack } from "./trackGeometry";
import autocrossRaw from "./tracks/autocross-2026-visual.json";
import enduranceRaw from "./tracks/endurance-2026-visual.json";

export const AUTOCROSS_2026_VISUAL: VisualTrack = parseVisualTrack(autocrossRaw as unknown as RawVisualTrack);
export const ENDURANCE_2026_VISUAL: VisualTrack = parseVisualTrack(enduranceRaw as unknown as RawVisualTrack);
