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

/** Split a delimited line, honoring double-quoted fields so a quoted thousands
 *  group ("11,480") survives a comma delimiter intact instead of being torn in
 *  two. Quotes are stripped; doubled quotes ("") inside a field unescape to one. */
function splitRow(line: string, delim: string): string[] {
  const out: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      out.push(field.trim());
      field = "";
    } else {
      field += ch;
    }
  }
  out.push(field.trim());
  return out;
}

/** Parse a numeric cell. The meaning of a comma is LOCALE-dependent and would
 *  otherwise be ambiguous (is "1,234" the number 1234 or 1.234?), so the caller
 *  resolves the locale ONCE from the delimiter (see parseDynoCsv) and passes it
 *  in via `commaIsDecimal`:
 *
 *    - `commaIsDecimal=true`  (";"/tab export, European convention): a single
 *      comma is the decimal point → "12,5" = 12.5, "17,159" = 17.159.
 *    - `commaIsDecimal=false` (US "," CSV): a comma can only be a thousands
 *      group separator (it survives splitRow only inside a quoted cell) →
 *      "11,480" = 11480, "1,234,567" = 1234567. This is the case the old
 *      `^-?\d+,\d+$` rule mangled, turning "11,480" rpm into 11.48 (~1000×).
 *
 *  Returns NaN for blank/non-numeric cells (caller treats NaN as "missing"). */
function parseNum(cell: string | undefined, commaIsDecimal: boolean): number {
  if (cell == null) return NaN;
  if (commaIsDecimal) {
    // Single comma, no dot → decimal comma. (A dotted value with commas is an
    // unexpected mix; leave it to Number(), which yields NaN and is skipped.)
    if (/^-?\d+,\d+$/.test(cell) && !cell.includes(".")) return Number(cell.replace(",", "."));
    return Number(cell);
  }
  // US locale: commas are thousands groups. Strip them when the value is a
  // well-formed grouped number ("1,234", "1,234,567", "1,234.5"); otherwise
  // leave it to Number().
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(cell)) return Number(cell.replace(/,/g, ""));
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
  // Locale: a ";"/tab export uses the comma as the DECIMAL point (European
  // convention); a "," CSV reserves the comma for the delimiter, so any comma
  // surviving inside a (quoted) cell is a thousands group, not a decimal.
  const commaIsDecimal = delim !== ",";
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
    // parseNum is locale-aware (commaIsDecimal): "12,5" → 12.5 on a ";" export,
    // while a quoted "11,480" → 11480 on a "," CSV (thousands group), instead
    // of the old rule that mangled "11,480" into 11.48.
    const rpm = parseNum(cells[rpmCol], commaIsDecimal);
    if (!Number.isFinite(rpm) || rpm <= 0) continue; // unit rows, comments, junk
    const pRaw = powerCol >= 0 ? parseNum(cells[powerCol], commaIsDecimal) : NaN;
    const tRaw = torqueCol >= 0 ? parseNum(cells[torqueCol], commaIsDecimal) : NaN;
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
