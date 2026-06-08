// Track model for the lap sim. A track is a sequence of segments, each a
// straight (radius = Infinity) or a constant-radius corner. Only the radius
// profile matters for a point-mass lap sim, so corner direction is irrelevant.
//
// The real 2026 competition courses (see ./tracks2026.ts, traced from the
// published course maps) are the production defaults. `synthesize*` below
// remains as a rules-spec SYNTHETIC FALLBACK (§D.11 autocross, §D.12 endurance)
// for tests / when no real track is supplied. `parseTrack` is the import seam:
// any source that yields `{ length, radius|null }` segments drops straight in.

export interface TrackSegment {
  /** Arc length of this segment (m). */
  length: number;
  /** Path radius (m); Infinity for a straight. */
  radius: number;
}

export interface Track {
  name: string;
  segments: TrackSegment[];
  /** Closed loop (endurance lap) vs point-to-point (autocross). */
  closed: boolean;
}

/** A track as it arrives from an external source (JSON file, GPS trace export):
 *  same shape as `Track` but a straight is `radius: null` rather than Infinity,
 *  since JSON can't carry Infinity. `parseTrack` normalizes it. */
export interface RawTrack {
  name: string;
  closed: boolean;
  segments: readonly { length: number; radius: number | null }[];
}

const STR = Infinity;

/** Normalize a raw/serialized track into a `Track`: a null or non-positive
 *  radius becomes a straight (Infinity), lengths are floored at 0. This is the
 *  single entry point for loading real (or GPS-traced) courses. */
export function parseTrack(raw: RawTrack): Track {
  return {
    name: raw.name,
    closed: raw.closed,
    segments: raw.segments.map((s) => ({
      length: Math.max(0, s.length),
      radius: s.radius != null && s.radius > 0 ? s.radius : STR,
    })),
  };
}

export function trackLength(t: Track): number {
  return t.segments.reduce((a, s) => a + Math.max(0, s.length), 0);
}

/** Uniformly sample the track into ~`ds`-spaced stations with the local radius
 *  at each. Uniform spacing keeps the QSS integration simple. */
export function discretizeTrack(
  t: Track,
  ds = 2,
): { radius: number[]; step: number; length: number } {
  const length = trackLength(t);
  const n = Math.max(2, Math.round(length / ds));
  const step = length / n;

  // Cumulative segment ends, for midpoint lookup.
  const bounds: { end: number; radius: number }[] = [];
  let acc = 0;
  for (const seg of t.segments) {
    acc += Math.max(0, seg.length);
    bounds.push({ end: acc, radius: seg.radius });
  }

  const radius = new Array<number>(n);
  let bi = 0;
  for (let i = 0; i < n; i++) {
    const d = (i + 0.5) * step;
    while (bi < bounds.length - 1 && d > bounds[bi]!.end) bi++;
    radius[i] = bounds[bi]?.radius ?? STR;
  }
  return { radius, step, length };
}

/** Repeat a feature motif until ~`target` metres, trimming the last segment. */
function buildFromMotif(
  name: string,
  motif: TrackSegment[],
  target: number,
  closed: boolean,
): Track {
  const segments: TrackSegment[] = [];
  let total = 0;
  let i = 0;
  while (total < target - 1e-6 && i < 10000) {
    const m = motif[i % motif.length]!;
    const remaining = target - total;
    const length = Math.min(m.length, remaining);
    segments.push({ length, radius: m.radius });
    total += length;
    i++;
  }
  return { name, segments, closed };
}

// §D.11 autocross features: straights ≤60 m, constant turns 23–45 m dia
// (R 11.5–22.5), hairpins ≥9 m dia (R ≥ 4.5), slaloms 7.62–12.19 m. ~270 m motif.
const AUTOCROSS_MOTIF: TrackSegment[] = [
  { length: 50, radius: STR },
  { length: 18.8, radius: 12 }, // ~90° R12
  { length: 30, radius: STR },
  { length: 31.4, radius: 20 }, // sweeper R20
  { length: 18.8, radius: 6 }, // hairpin
  { length: 25, radius: STR },
  { length: 14.1, radius: 9 }, // slalom-ish
  { length: 9, radius: STR },
  { length: 14.1, radius: 9 },
  { length: 35, radius: STR },
  { length: 23.6, radius: 15 },
];

// §D.12 endurance features: straights ≤77 m, turns 30–54 m dia (R 15–27),
// hairpins ≥9 m, slaloms 9–15 m. ~367 m motif, closed loop.
const ENDURANCE_MOTIF: TrackSegment[] = [
  { length: 70, radius: STR },
  { length: 31.4, radius: 20 },
  { length: 60, radius: STR },
  { length: 42, radius: 27 },
  { length: 18.8, radius: 6 }, // hairpin
  { length: 50, radius: STR },
  { length: 23.6, radius: 15 },
  { length: 40, radius: STR },
  { length: 31.4, radius: 20 },
];

/** Rules-spec autocross course (~0.8 km, point-to-point). Synthetic fallback —
 *  the real course is AUTOCROSS_2026 (./tracks2026.ts). */
export function synthesizeAutocross(): Track {
  return buildFromMotif("Autocross (synthetic)", AUTOCROSS_MOTIF, 800, false);
}

/** Rules-spec endurance lap (~1 km closed loop). Synthetic fallback — the real
 *  course is ENDURANCE_2026 (./tracks2026.ts). Total endurance distance
 *  (~22 km) = this lap × lap count. */
export function synthesizeEndurance(): Track {
  return buildFromMotif("Endurance lap (synthetic)", ENDURANCE_MOTIF, 1000, true);
}
