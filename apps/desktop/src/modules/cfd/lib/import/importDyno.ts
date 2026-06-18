// Dyno CSV import (pure parser — io stays at the call site, same seam pattern
// as importStudy). Accepts the team's reference format
// (physics_findings/references/dyno/*.csv: rpm,brake_power_kW,brake_torque_Nm,…)
// and common Dynojet exports: any delimited file with an rpm column plus a
// power and/or torque column. Units are detected from the header (hp → kW,
// lb-ft → Nm) so a raw Dynojet sheet imports without hand-editing.
//
// Dyno reference data is IMPORTED AT RUNTIME and stored on the study — never
// bundled into the app (real dyno CSVs must not ship in the public repo).

export interface DynoPoint {
  rpm: number;
  powerKw: number | null;
  torqueNm: number | null;
}

export interface DynoRef {
  /** Display label, e.g. the imported file's basename. */
  label: string;
  points: DynoPoint[];
  /** Count of rows with a valid rpm but no usable power/torque cell (e.g.
   *  numbers lost to an unhandled locale format); present only when > 0 so
   *  the call site can warn rather than silently dropping data. */
  skippedRows?: number;
}

const HP_TO_KW = 0.7456999;
const LBFT_TO_NM = 1.3558179;

/** Power for a point, deriving from torque (P = τ·ω) when not given. */
export function dynoPowerKw(p: DynoPoint): number | null {
  if (p.powerKw != null) return p.powerKw;
  if (p.torqueNm != null) return (p.torqueNm * p.rpm * 2 * Math.PI) / 60 / 1000;
  return null;
}

/** Torque for a point, deriving from power when not given. */
export function dynoTorqueNm(p: DynoPoint): number | null {
  if (p.torqueNm != null) return p.torqueNm;
  if (p.powerKw != null && p.rpm > 0) return (p.powerKw * 1000 * 60) / (2 * Math.PI * p.rpm);
  return null;
}

function splitRow(line: string, delim: string): string[] {
  return line.split(delim).map((c) => c.trim().replace(/^"|"$/g, ""));
}

/** Parse a numeric cell, tolerating the European decimal comma (e.g. "12,5").
 *  Returns NaN for blank/non-numeric cells (caller treats NaN as "missing"). */
function parseNum(cell: string | undefined): number {
  if (cell == null) return NaN;
  // Only a bare "123,45" is a decimal comma; anything else (thousands groups,
  // already-dotted numbers) is left to Number() so we never mangle "1,234.5".
  if (/^-?\d+,\d+$/.test(cell)) return Number(cell.replace(",", "."));
  return Number(cell);
}

/** Parse a dyno CSV. Throws a user-facing Error when no rpm column or no
 *  power/torque column can be found, or no numeric rows survive. */
export function parseDynoCsv(text: string, label: string): DynoRef {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error("Dyno CSV needs a header row and at least one data row.");

  // Delimiter: whichever splits the header into the most columns.
  const delim = [",", ";", "\t"].reduce((best, d) =>
    splitRow(lines[0]!, d).length > splitRow(lines[0]!, best).length ? d : best, ",");
  const header = splitRow(lines[0]!, delim).map((h) => h.toLowerCase());

  const rpmCol = header.findIndex((h) => h.includes("rpm"));
  // Prefer explicit kW/Nm columns; fall back to anything that says power/torque.
  const powerCol = header.findIndex((h) => h.includes("kw") || h.includes("power") || h.includes("hp"));
  const torqueCol = header.findIndex(
    (h) => h.includes("nm") || h.includes("torque") || h.includes("tq") || h.includes("lb"),
  );
  if (rpmCol < 0) throw new Error('Dyno CSV needs an "rpm" column.');
  if (powerCol < 0 && torqueCol < 0) {
    throw new Error("Dyno CSV needs a power (kW/hp) or torque (Nm/lb-ft) column.");
  }
  const powerScale = powerCol >= 0 && header[powerCol]!.includes("hp") && !header[powerCol]!.includes("kw")
    ? HP_TO_KW : 1;
  const torqueScale = torqueCol >= 0 && header[torqueCol]!.includes("lb") ? LBFT_TO_NM : 1;

  const points: DynoPoint[] = [];
  let skipped = 0;
  for (const line of lines.slice(1)) {
    const cells = splitRow(line, delim);
    // parseNum tolerates the European decimal comma (";"-delimited exports
    // almost always pair it), so "12,5" no longer silently becomes NaN.
    const rpm = parseNum(cells[rpmCol]);
    if (!Number.isFinite(rpm) || rpm <= 0) continue; // unit rows, comments, junk
    const pRaw = powerCol >= 0 ? parseNum(cells[powerCol]) : NaN;
    const tRaw = torqueCol >= 0 ? parseNum(cells[torqueCol]) : NaN;
    const powerKw = Number.isFinite(pRaw) ? pRaw * powerScale : null;
    const torqueNm = Number.isFinite(tRaw) ? tRaw * torqueScale : null;
    if (powerKw == null && torqueNm == null) {
      skipped++; // a real rpm but no usable power/torque — surface it below
      continue;
    }
    points.push({ rpm, powerKw, torqueNm });
  }
  if (points.length === 0) throw new Error("Dyno CSV had no numeric data rows.");
  points.sort((a, b) => a.rpm - b.rpm);
  return { label, points, ...(skipped > 0 ? { skippedRows: skipped } : {}) };
}
