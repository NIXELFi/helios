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

export interface TurnDetectOptions {
  /** Yaw-rate magnitude in rad/s above which we call a sample "turning".
   *  ~0.3 rad/s ≈ 17°/s — typical of an FSAE corner. */
  turnThresholdRadPerSec: number;
  /** Reject contiguous turn runs shorter than this many milliseconds.
   *  Filters out single noisy samples that briefly cross the threshold. */
  minTurnDurationMs: number;
  /** Smoothing window (samples) for the yaw-rate signal. Wider = fewer
   *  spurious turn detections, but blurs adjacent-corner boundaries. */
  smoothingWindow: number;
  /** When true, also emit straight labels (S1, S2…) between detected turns. */
  emitStraights: boolean;
}

export const DEFAULT_TURN_OPTIONS: TurnDetectOptions = {
  turnThresholdRadPerSec: 0.30,
  minTurnDurationMs: 400,
  smoothingWindow: 7,
  emitStraights: false,
};

/** Detect turns (and optionally straights) from a single session's lat/lon
 *  trace. Returns labels in lap order (T1, T2, …, S1, S2, …).
 *
 *  Algorithm:
 *  1. Project lat/lon to a local meters frame at the trace centroid so the
 *     east/north components are real distances. (Without the cos(lat) scale
 *     a degree of longitude looks the same length as a degree of latitude
 *     and the bearings come out wrong outside the equator.)
 *  2. Compute the bearing between every consecutive pair of points.
 *  3. Compute yaw rate (Δbearing / Δt) and smooth it with a moving average.
 *  4. Threshold |yaw rate| against `turnThresholdRadPerSec` to a binary
 *     turning/not-turning array.
 *  5. Walk it to find contiguous turning runs; reject runs shorter than
 *     `minTurnDurationMs`.
 *  6. Each surviving run is a turn; place its label at the centroid lat/lon
 *     of its samples. Straights are the gaps between consecutive turns. */
export function detectTrackLabels(
  lat: Float64Array,
  lon: Float64Array,
  timeUs: BigInt64Array,
  options: TurnDetectOptions = DEFAULT_TURN_OPTIONS,
): TrackLabel[] {
  const n = Math.min(lat.length, lon.length, timeUs.length);
  if (n < 5) return [];

  // Mean lat for the cos-scale. Using the centroid of the actual data is
  // more accurate than the bbox center for any non-symmetric track.
  let meanLat = 0;
  for (let i = 0; i < n; i++) meanLat += lat[i]!;
  meanLat /= n;
  const cosLat = Math.cos(meanLat * Math.PI / 180);
  const M_PER_DEG = 111_320; // good to <0.3% across normal driving latitudes

  // Bearings between consecutive points (radians, atan2 of (dy, dx) where
  // y is north and x is east — i.e. 0 = east, π/2 = north).
  const bearings = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    const dxM = (lon[i + 1]! - lon[i]!) * cosLat * M_PER_DEG;
    const dyM = (lat[i + 1]! - lat[i]!) * M_PER_DEG;
    bearings[i] = Math.atan2(dyM, dxM);
  }

  // Yaw rate (rad/s). Unwrap each Δbearing across the ±π discontinuity so a
  // car doing a U-turn doesn't read as a single spike followed by a noise
  // burst. yaw[i] is associated with the i+1'th sample.
  const yaw = new Float64Array(n - 2);
  for (let i = 0; i < n - 2; i++) {
    let d = bearings[i + 1]! - bearings[i]!;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    const dtSec = Number(timeUs[i + 2]! - timeUs[i + 1]!) / 1_000_000;
    yaw[i] = dtSec > 0 ? d / dtSec : 0;
  }

  // Moving-average smoothing.
  const win = Math.max(1, options.smoothingWindow);
  const half = Math.floor(win / 2);
  const smooth = new Float64Array(yaw.length);
  for (let i = 0; i < yaw.length; i++) {
    let sum = 0, count = 0;
    const lo = Math.max(0, i - half);
    const hi = Math.min(yaw.length, i + half + 1);
    for (let j = lo; j < hi; j++) { sum += yaw[j]!; count++; }
    smooth[i] = count > 0 ? sum / count : 0;
  }

  // Find contiguous runs above threshold.
  const thr = options.turnThresholdRadPerSec;
  const runs: Array<{ start: number; end: number }> = [];
  let runStart = -1;
  for (let i = 0; i < smooth.length; i++) {
    const turning = Math.abs(smooth[i]!) >= thr;
    if (turning && runStart === -1) runStart = i;
    else if (!turning && runStart !== -1) {
      runs.push({ start: runStart, end: i });
      runStart = -1;
    }
  }
  if (runStart !== -1) runs.push({ start: runStart, end: smooth.length });

  // Convert each run's index range to a sample-index range in the original
  // arrays (yaw[i] is associated with sample i+1; the run spans yaw[start..end)
  // → samples [start+1, end+1) in the original lat/lon).
  const turnRanges = runs
    .map((r) => ({ start: r.start + 1, end: r.end + 1 }))
    .filter((r) => {
      if (r.end <= r.start) return false;
      const startUs = Number(timeUs[r.start]!);
      const endUs = Number(timeUs[r.end - 1]!);
      return (endUs - startUs) / 1000 >= options.minTurnDurationMs;
    });

  const labels: TrackLabel[] = [];
  // Turns first, in lap order.
  turnRanges.forEach((r, idx) => {
    labels.push({ text: `T${idx + 1}`, kind: "turn", ...centroid(lat, lon, r.start, r.end) });
  });

  if (options.emitStraights) {
    // Straight = the sample range between two consecutive turns (or before
    // the first / after the last). Skip any straight shorter than 5 samples
    // so we don't litter the chart with one-pixel labels.
    const straightRanges: Array<{ start: number; end: number }> = [];
    let prevEnd = 0;
    for (const t of turnRanges) {
      if (t.start - prevEnd >= 5) straightRanges.push({ start: prevEnd, end: t.start });
      prevEnd = t.end;
    }
    if (n - prevEnd >= 5) straightRanges.push({ start: prevEnd, end: n });
    straightRanges.forEach((r, idx) => {
      labels.push({ text: `S${idx + 1}`, kind: "straight", ...centroid(lat, lon, r.start, r.end) });
    });
  }

  return labels;
}

function centroid(lat: Float64Array, lon: Float64Array, start: number, end: number): { lat: number; lon: number } {
  let sumLat = 0, sumLon = 0, count = 0;
  for (let i = start; i < end; i++) {
    sumLat += lat[i]!;
    sumLon += lon[i]!;
    count++;
  }
  if (count === 0) return { lat: 0, lon: 0 };
  return { lat: sumLat / count, lon: sumLon / count };
}
