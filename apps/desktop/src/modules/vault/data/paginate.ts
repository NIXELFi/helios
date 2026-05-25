// PostgREST defaults to a 1000-row response cap (configurable per project but
// effectively immutable from the client). Any query that could exceed 1000
// must paginate by .range(). Helios's SDM26 vault has 4,400+ files, so the
// vault-wide hooks were silently truncating to the first 1000.
//
// This helper loops .range() requests until a partial page (< pageSize) comes
// back. Caller supplies a builder that returns a fresh query for each page.
//
// We use range(start, end) inclusive on PostgREST. PostgREST also has a
// configurable hard cap that may be >1000, but we stay conservative at 1000.

const PAGE = 1000;

export async function fetchAllRows<T>(
  buildQuery: () => any,
): Promise<{ rows: T[]; error: Error | null }> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const to = from + PAGE - 1;
    const { data, error } = await buildQuery().range(from, to);
    if (error) {
      return { rows: out, error: new Error(error.message ?? String(error)) };
    }
    const page = (data ?? []) as T[];
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return { rows: out, error: null };
}
