/** A single label to draw on the GPS track. */
export interface TrackLabel {
  /** Display text — e.g. "T1", "T7", "S2". */
  text: string;
  /** Latitude of the label centroid, in degrees. */
  lat: number;
  /** Longitude of the label centroid, in degrees. */
  lon: number;
  /** Whether this label is a turn (versus a straight). Lets the renderer
   *  style turns and straights differently. */
  kind: "turn" | "straight";
}

export type Sensitivity = "low" | "medium" | "high";

export interface TurnDetectOptions {
  /** Reject contiguous turn runs shorter than this many milliseconds. */
  minTurnDurationMs: number;
  /** Smoothing window (samples) for the cornering signal. */
  smoothingWindow: number;
  /** When true, also emit straight labels (S1, S2…) between detected turns. */
  emitStraights: boolean;
  /** Threshold on |lat_g| (in G) when the lat_g signal is used. */
  latGThresholdG: number;
  /** Threshold on |yaw rate| (rad/s) when the GPS-only signal is used. */
  yawRateThresholdRadPerSec: number;
  /** GPS-only fallback: how many samples to look ahead when computing the
   *  bearing direction vector. Larger = more noise-resistant on bad GPS,
   *  but blurs short corner boundaries. ~200 ms worth of samples is a
   *  reasonable starting point for FSAE-rate data. */
  gpsLookaheadSamples: number;
}

export const SENSITIVITY_PRESETS: Record<Sensitivity, TurnDetectOptions> = {
  low: {
    minTurnDurationMs: 600,
    smoothingWindow: 11,
    emitStraights: false,
    latGThresholdG: 0.6,
    yawRateThresholdRadPerSec: 0.45,
    gpsLookaheadSamples: 10,
  },
  medium: {
    minTurnDurationMs: 350,
    smoothingWindow: 9,
    emitStraights: false,
    latGThresholdG: 0.35,
    yawRateThresholdRadPerSec: 0.22,
    gpsLookaheadSamples: 10,
  },
  high: {
    minTurnDurationMs: 200,
    smoothingWindow: 7,
    emitStraights: false,
    latGThresholdG: 0.2,
    yawRateThresholdRadPerSec: 0.12,
    gpsLookaheadSamples: 12,
  },
};

const M_PER_DEG = 111_320;

/** Detect turns (and optionally straights) from a single session.
 *
 *  When `latG` is provided and looks valid, the detector uses |lat_g| as
 *  the cornering signal — it's a chassis-frame measurement of cornering
 *  force, robust against GPS noise and applicable even when the GPS
 *  receiver is glitchy or upsampled. Otherwise it falls back to a GPS
 *  path-curvature signal with a configurable lookahead window so the
 *  bearing vector escapes per-sample jitter.
 *
 *  Both paths produce a smoothed cornering signal, threshold it to a
 *  binary turning array, walk that for contiguous runs longer than the
 *  configured minimum duration, and emit centroid-positioned labels in
 *  lap order. */
export function detectTrackLabels(
  lat: Float64Array,
  lon: Float64Array,
  timeUs: BigInt64Array,
  options: TurnDetectOptions,
  latG?: Float64Array,
): TrackLabel[] {
  const n = Math.min(lat.length, lon.length, timeUs.length);
  if (n < 5) return [];

  const useLatG = !!latG && hasValidLatG(latG, n);
  const signal = useLatG
    ? buildSignalFromLatG(latG!, n)
    : buildSignalFromGps(lat, lon, timeUs, n, options.gpsLookaheadSamples);

  const smoothed = movingAverage(signal, options.smoothingWindow);
  const threshold = useLatG ? options.latGThresholdG : options.yawRateThresholdRadPerSec;

  // Walk the smoothed signal for contiguous runs above threshold. The signal
  // is index-aligned with `lat`/`lon`/`timeUs` (NaN-padded at the start and
  // end where the underlying derivative isn't defined).
  const runs: Array<{ start: number; end: number }> = [];
  let runStart = -1;
  for (let i = 0; i < smoothed.length; i++) {
    const v = smoothed[i]!;
    const turning = Number.isFinite(v) && Math.abs(v) >= threshold;
    if (turning && runStart === -1) runStart = i;
    else if (!turning && runStart !== -1) {
      runs.push({ start: runStart, end: i });
      runStart = -1;
    }
  }
  if (runStart !== -1) runs.push({ start: runStart, end: smoothed.length });

  const turns = runs.filter((r) => {
    if (r.end <= r.start) return false;
    const startUs = Number(timeUs[Math.min(n - 1, r.start)]!);
    const endUs = Number(timeUs[Math.min(n - 1, r.end - 1)]!);
    return (endUs - startUs) / 1000 >= options.minTurnDurationMs;
  });

  const labels: TrackLabel[] = [];
  turns.forEach((r, idx) => {
    labels.push({ text: `T${idx + 1}`, kind: "turn", ...centroid(lat, lon, r.start, r.end) });
  });

  if (options.emitStraights) {
    const straights: Array<{ start: number; end: number }> = [];
    let prevEnd = 0;
    for (const t of turns) {
      if (t.start - prevEnd >= 5) straights.push({ start: prevEnd, end: t.start });
      prevEnd = t.end;
    }
    if (n - prevEnd >= 5) straights.push({ start: prevEnd, end: n });
    straights.forEach((r, idx) => {
      labels.push({ text: `S${idx + 1}`, kind: "straight", ...centroid(lat, lon, r.start, r.end) });
    });
  }

  return labels;
}

/** A "valid" lat_g array is one with at least a handful of real (finite,
 *  non-zero) samples. MoTeC exports without an IMU often ship a column
 *  full of zeros which would otherwise pass through and produce no
 *  detections, masking the GPS fallback. */
function hasValidLatG(latG: Float64Array, n: number): boolean {
  const len = Math.min(latG.length, n);
  let nonZero = 0;
  for (let i = 0; i < len; i++) {
    const v = latG[i];
    if (Number.isFinite(v) && Math.abs(v as number) > 0.05) nonZero++;
    if (nonZero >= 5) return true;
  }
  return false;
}

/** Cornering signal = |lat_g|. Same length as the source; non-finite
 *  values become NaN so they don't slip through the threshold. */
function buildSignalFromLatG(latG: Float64Array, n: number): Float64Array {
  const len = Math.min(latG.length, n);
  const out = new Float64Array(n);
  for (let i = 0; i < len; i++) {
    const v = latG[i];
    out[i] = Number.isFinite(v) ? Math.abs(v as number) : NaN;
  }
  // Pad any tail with NaN so this stays aligned with lat/lon length n.
  for (let i = len; i < n; i++) out[i] = NaN;
  return out;
}

/** Cornering signal from GPS path curvature. Computes a "look-ahead
 *  bearing" — the direction from sample i to sample i + lookahead — so
 *  jittery GPS where adjacent samples nearly coincide doesn't poison
 *  the bearing array with noisy atan2(0, 0)-ish results. The signal
 *  returned is yaw rate (rad/s) from the difference of consecutive
 *  lookahead bearings. */
function buildSignalFromGps(
  lat: Float64Array,
  lon: Float64Array,
  timeUs: BigInt64Array,
  n: number,
  lookahead: number,
): Float64Array {
  if (n < lookahead + 2) return new Float64Array(n);

  let meanLat = 0;
  for (let i = 0; i < n; i++) meanLat += lat[i]!;
  meanLat /= n;
  const cosLat = Math.cos(meanLat * Math.PI / 180);

  const bearings = new Float64Array(n);
  for (let i = 0; i < n; i++) bearings[i] = NaN;
  for (let i = 0; i + lookahead < n; i++) {
    const dxM = (lon[i + lookahead]! - lon[i]!) * cosLat * M_PER_DEG;
    const dyM = (lat[i + lookahead]! - lat[i]!) * M_PER_DEG;
    if (dxM * dxM + dyM * dyM < 0.01) {
      // < 10 cm of movement across the lookahead window → no real
      // direction. Inherit previous bearing for continuity.
      bearings[i] = i > 0 ? bearings[i - 1]! : NaN;
    } else {
      bearings[i] = Math.atan2(dyM, dxM);
    }
  }

  const yaw = new Float64Array(n);
  for (let i = 0; i < n; i++) yaw[i] = NaN;
  for (let i = 0; i + 1 < n; i++) {
    const a = bearings[i], b = bearings[i + 1];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    let d = (b as number) - (a as number);
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    const dtSec = Number(timeUs[i + 1]! - timeUs[i]!) / 1_000_000;
    yaw[i] = dtSec > 0 ? d / dtSec : 0;
  }
  return yaw;
}

function movingAverage(src: Float64Array, window: number): Float64Array {
  const w = Math.max(1, window);
  const half = Math.floor(w / 2);
  const out = new Float64Array(src.length);
  for (let i = 0; i < src.length; i++) {
    let sum = 0, count = 0;
    const lo = Math.max(0, i - half);
    const hi = Math.min(src.length, i + half + 1);
    for (let j = lo; j < hi; j++) {
      const v = src[j];
      if (Number.isFinite(v)) { sum += v as number; count++; }
    }
    out[i] = count > 0 ? sum / count : NaN;
  }
  return out;
}

function centroid(lat: Float64Array, lon: Float64Array, start: number, end: number): { lat: number; lon: number } {
  let sumLat = 0, sumLon = 0, count = 0;
  const a = Math.max(0, start);
  const b = Math.min(lat.length, end);
  for (let i = a; i < b; i++) {
    sumLat += lat[i]!;
    sumLon += lon[i]!;
    count++;
  }
  if (count === 0) return { lat: 0, lon: 0 };
  return { lat: sumLat / count, lon: sumLon / count };
}
