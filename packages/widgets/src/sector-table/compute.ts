/* Pure compute for the sector-table widget.
 *
 * "Sector" semantics here: a lap is split into N equal-distance bands from
 * lap start to lap end. For each lap + sector, we compute the elapsed time
 * inside that sector (the time spent between distance-band start and end).
 * Cross-lap comparison surfaces the fastest sector ever achieved (purple) and
 * the theoretical-best lap (sum of every sector's purple).
 *
 * Auto-equal-distance was chosen as the v1 sectoring policy because it
 * requires no UI — three sectors of "one third lap each" is a sensible
 * default. A future iteration can let users place markers on the GPS track
 * or pick distance offsets explicitly. */

export interface LapInput {
  /** Per-sample time in microseconds, indexed across the entire session. */
  timeUs: BigInt64Array;
  /** Per-sample distance along this lap (NaN outside the lap). Output of
   *  perSampleLapDistance — same array shape as timeUs. */
  dist: Float64Array;
  lapStartUs: number;
  lapEndUs: number;
  /** Lap-display id (e.g., `${index}`, "best"). Carried through as a label. */
  label: string;
  /** Total lap duration in seconds, for the trailing "Lap" column. */
  durationS: number;
}

export interface SectorRow {
  label: string;
  /** Per-sector durations in seconds. NaN where the sector couldn't be
   *  computed (lap data was missing or the lap's max distance was below
   *  the sector's end boundary). */
  sectorS: number[];
  totalS: number;
}

export interface SectorTable {
  /** Sector display names (S1, S2, …) — same length as each row's sectorS. */
  names: string[];
  rows: SectorRow[];
  /** Best (smallest) time per sector across all rows. NaN entries in rows
   *  are skipped. NaN here means no row had a valid time for that sector. */
  bestS: number[];
  /** Sum of bestS. NaN if any sector lacks a best. */
  optimalTotalS: number;
}

/** Build a sector table from a set of (lap data, sector count). Each sector
 *  spans `lapMaxDist / nSectors` meters. We assume distance within a lap is
 *  monotonic non-decreasing — defended by clamping with the running max. */
export function buildSectorTable(laps: LapInput[], nSectors: number): SectorTable {
  if (nSectors < 1) nSectors = 1;
  const names = Array.from({ length: nSectors }, (_, i) => `S${i + 1}`);
  const rows: SectorRow[] = [];
  for (const lap of laps) {
    rows.push(rowFor(lap, nSectors));
  }
  const bestS = Array.from({ length: nSectors }, (_, i) => {
    let best = NaN;
    for (const r of rows) {
      const v = r.sectorS[i]!;
      if (!Number.isFinite(v)) continue;
      if (!Number.isFinite(best) || v < best) best = v;
    }
    return best;
  });
  const optimalTotalS = bestS.every((v) => Number.isFinite(v))
    ? bestS.reduce((s, v) => s + v, 0)
    : NaN;
  return { names, rows, bestS, optimalTotalS };
}

function rowFor(lap: LapInput, nSectors: number): SectorRow {
  // Walk the lap once to (a) find max distance, (b) record the time at the
  // first sample whose distance crosses each sector boundary. The sector
  // time is then time[at_end] − time[at_start]; the first sector starts at
  // lap start time, the last ends at lap end time.
  const sectorS = new Array<number>(nSectors).fill(NaN);
  const n = Math.min(lap.timeUs.length, lap.dist.length);
  let i0 = -1, i1 = -1;
  let maxDist = -Infinity;
  for (let i = 0; i < n; i++) {
    const t = Number(lap.timeUs[i]!);
    if (t < lap.lapStartUs) continue;
    if (t > lap.lapEndUs) break;
    if (i0 < 0) i0 = i;
    i1 = i;
    const d = lap.dist[i]!;
    if (Number.isFinite(d) && d > maxDist) maxDist = d;
  }
  if (i0 < 0 || i1 < i0 || !Number.isFinite(maxDist) || maxDist <= 0) {
    return { label: lap.label, sectorS, totalS: lap.durationS };
  }
  const sectorSize = maxDist / nSectors;
  // Boundaries: sector k ENDS at distance (k+1) * sectorSize. Sector k starts
  // at sector (k-1)'s end (or 0 for k=0). We find, for each boundary, the
  // sample index whose distance first reaches it.
  const boundaryIdx: number[] = [i0];
  let cur = 0;
  let running = -Infinity;
  for (let i = i0; i <= i1; i++) {
    const d = lap.dist[i]!;
    if (!Number.isFinite(d)) continue;
    const clamped = d < running ? running : d;
    running = clamped;
    while (cur < nSectors && clamped >= (cur + 1) * sectorSize) {
      boundaryIdx.push(i);
      cur++;
    }
    if (cur >= nSectors) break;
  }
  // If the lap ends slightly short of the nominal max (rounding), pad the
  // remaining boundary to i1 so the final sector still gets credited.
  while (boundaryIdx.length <= nSectors) boundaryIdx.push(i1);
  for (let k = 0; k < nSectors; k++) {
    const a = boundaryIdx[k]!;
    const b = boundaryIdx[k + 1]!;
    if (b <= a) continue;
    const tA = Number(lap.timeUs[a]!);
    const tB = Number(lap.timeUs[b]!);
    sectorS[k] = (tB - tA) / 1_000_000;
  }
  return { label: lap.label, sectorS, totalS: lap.durationS };
}

export function formatLapTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "—";
  const min = Math.floor(s / 60);
  const sec = s - min * 60;
  if (min === 0) return sec.toFixed(2);
  return `${min}:${sec.toFixed(2).padStart(5, "0")}`;
}
