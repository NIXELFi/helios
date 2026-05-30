// PostgREST defaults to a 1000-row response cap (configurable per project but
// effectively immutable from the client). Any query that could exceed 1000
// must paginate by .range(). Helios's SDM26 vault has 4,400+ files, so the
// vault-wide hooks were silently truncating to the first 1000.
//
// This helper loops .range() requests until a partial page comes back. Caller
// supplies a builder that returns a fresh query for each page.
//
// We use range(start, end) inclusive on PostgREST. PostgREST also has a
// configurable `db-max-rows` cap. If that cap is set BELOW PAGE, every full
// page comes back smaller than PAGE — so a naive "stop when page < PAGE"
// loop would stop after the first page and silently truncate (H11). To stay
// correct regardless of the server's cap, we detect the effective page size
// from the FIRST response and use that as the stop threshold thereafter.

const PAGE = 1000;

// Runaway guard: even with a correct stop condition, a misbehaving source
// (always returning a full page, or a zero-width page that never advances)
// could loop forever. These caps throw a clear error instead of hanging the
// renderer. They sit far above any legitimate vault (4,400 files ≈ 5 pages).
const MAX_ITERATIONS = 10_000;
const MAX_ROWS = 5_000_000;

export async function fetchAllRows<T>(
  buildQuery: () => any,
): Promise<{ rows: T[]; error: Error | null }> {
  const out: T[] = [];
  // Effective page size: PAGE until the first response tells us the server
  // caps lower. We request PAGE rows on the first call to probe the cap.
  let pageSize = PAGE;
  let from = 0;
  for (let iter = 0; ; iter++) {
    if (iter >= MAX_ITERATIONS || out.length > MAX_ROWS) {
      throw new Error(
        `fetchAllRows: pagination runaway guard tripped (iterations=${iter}, rows=${out.length}). ` +
          `The data source did not terminate as expected.`,
      );
    }
    const to = from + pageSize - 1;
    const { data, error } = await buildQuery().range(from, to);
    if (error) {
      return { rows: out, error: new Error(error.message ?? String(error)) };
    }
    const page = (data ?? []) as T[];
    out.push(...page);

    if (iter === 0 && page.length === 0) break; // no rows at all; nothing to page.

    // Effective page size = the LARGEST page seen so far. The first response
    // probes the cap, but a later response can come back larger (a server that
    // ignores the range upper bound, or a cap that lifts mid-scan). Tracking the
    // max keeps the partial-page stop condition correct in that case.
    if (page.length > pageSize || iter === 0) pageSize = page.length;

    // A page shorter than the effective page size is the last page.
    if (page.length < pageSize) break;
    // Advance by the rows we ACTUALLY received, not the probe size — advancing
    // by a stale/smaller probe would re-request rows already collected and
    // duplicate them when a page exceeds the probe (PAGINATE-ADVANCE).
    from += page.length;
  }
  return { rows: out, error: null };
}
