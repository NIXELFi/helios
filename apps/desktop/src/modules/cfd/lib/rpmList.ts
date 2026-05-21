// Parser for the sweep modal's RPM-list text input.
//
// Accepts:
//   - comma-separated:        "4000, 5000, 6000, 7000, 8000"
//   - range with step:        "4000:12000:1000"   →  [4000..12000 step 1000]
//   - mixed:                  "4000:6000:1000, 8000, 10000:12000:500"
//
// Validation:
//   - every value lies in [500, 20000]
//   - total count in [1, 50]
//   - sorted ascending + deduped on the way out

const RPM_MIN = 500;
const RPM_MAX = 20000;
// Bumped from 50 -> 2000 so users can run dense parametric studies
// (e.g. 500..15000 step 25 = ~580 points). Wall time is the real
// constraint, not this sanity bound.
const MAX_COUNT = 2000;

export type ParseResult =
  | { ok: true; rpms: number[] }
  | { ok: false; error: string };

export function parseRpmList(input: string): ParseResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: "Empty RPM list." };

  // Split on commas, then expand each segment (may be a single rpm or a
  // range). Collect into a flat array, then dedup + sort + validate.
  const segments = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return { ok: false, error: "Empty RPM list." };

  const out: number[] = [];
  for (const seg of segments) {
    if (seg.includes(":")) {
      const parts = seg.split(":").map((s) => s.trim());
      if (parts.length !== 3) {
        return { ok: false, error: `Bad range "${seg}". Use start:stop:step.` };
      }
      const start = Number(parts[0]);
      const stop = Number(parts[1]);
      const step = Number(parts[2]);
      if (!Number.isFinite(start) || !Number.isFinite(stop) || !Number.isFinite(step)) {
        return { ok: false, error: `Bad range "${seg}". Each part must be a number.` };
      }
      if (step <= 0) {
        return { ok: false, error: `Range "${seg}" must have a positive step.` };
      }
      if (stop < start) {
        return { ok: false, error: `Range "${seg}": stop (${stop}) is below start (${start}).` };
      }
      // Inclusive-inclusive with a small float tolerance on the upper bound
      // so 4000:12000:1000 includes 12000 even after FP drift.
      const eps = step * 1e-9;
      for (let v = start; v <= stop + eps; v += step) {
        out.push(Math.round(v));
        if (out.length > MAX_COUNT * 4) {
          return { ok: false, error: `Too many RPMs (max ${MAX_COUNT}).` };
        }
      }
    } else {
      const v = Number(seg);
      if (!Number.isFinite(v)) {
        return { ok: false, error: `Not a number: "${seg}".` };
      }
      out.push(Math.round(v));
    }
  }

  // Dedup + sort.
  const unique = Array.from(new Set(out)).sort((a, b) => a - b);
  if (unique.length === 0) return { ok: false, error: "Empty RPM list." };
  if (unique.length > MAX_COUNT) {
    return { ok: false, error: `Too many RPMs (${unique.length}); max ${MAX_COUNT}.` };
  }
  for (const v of unique) {
    if (v < RPM_MIN || v > RPM_MAX) {
      return { ok: false, error: `RPM ${v} out of range [${RPM_MIN}, ${RPM_MAX}].` };
    }
  }
  return { ok: true, rpms: unique };
}

export function formatRpmList(rpms: number[]): string {
  return rpms.map((v) => v.toString()).join(", ");
}
