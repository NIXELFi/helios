/**
 * Circuit breaker for auto-sync, per computer, per vault, per calendar day.
 *
 * Auto-sync downloads on its own, so a bug that makes it fetch the same thing
 * again and again costs storage bandwidth on every machine at once. That
 * happened in early November 2026 (about 550 GB in three days). The specific
 * loop is fixed; this catches the next one we haven't thought of, and it
 * warns rather than blocks:
 *
 * - The same file content (sha + path) successfully downloaded REPEAT_LIMIT
 *   times today: auto-sync stops fetching it and says so. Get Latest still
 *   works. Failures don't count here; the per-file backoff handles them.
 * - More than the day's budget downloaded for a vault: auto-sync pauses with a
 *   "Continue syncing" button. The budget is 1.5x the vault's full size plus
 *   5 GB, so a brand-new full sync never trips it.
 */

export const REPEAT_LIMIT = 3;

export interface DayGuard {
  day: string;
  bytes: number;
  fetches: Record<string, number>;
  /** The user pressed "Continue syncing" today. */
  continued: boolean;
}

const KEY_PREFIX = "helios.vault.autoSyncGuard.";

export function today(now: Date = new Date()): string {
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${m}-${d}`;
}

export function emptyGuard(day: string): DayGuard {
  return { day, bytes: 0, fetches: {}, continued: false };
}

export function loadGuard(vaultId: string, day: string = today()): DayGuard {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + vaultId);
    if (!raw) return emptyGuard(day);
    const g = JSON.parse(raw) as Partial<DayGuard>;
    if (g.day !== day || typeof g.bytes !== "number" || typeof g.fetches !== "object" || !g.fetches) {
      return emptyGuard(day);
    }
    return { day, bytes: g.bytes, fetches: g.fetches, continued: g.continued === true };
  } catch {
    return emptyGuard(day);
  }
}

export function saveGuard(vaultId: string, g: DayGuard): void {
  try { localStorage.setItem(KEY_PREFIX + vaultId, JSON.stringify(g)); } catch { /* storage full/blocked: guard is best-effort */ }
}

export function dailyBudgetBytes(vaultBytes: number): number {
  return Math.round(vaultBytes * 1.5) + 5_000_000_000;
}

export function isRepeatBlocked(g: DayGuard, key: string): boolean {
  return (g.fetches[key] ?? 0) >= REPEAT_LIMIT;
}

export function isOverBudget(g: DayGuard, vaultBytes: number): boolean {
  return !g.continued && g.bytes >= dailyBudgetBytes(vaultBytes);
}

/** Count one successful download. */
export function recordFetch(g: DayGuard, key: string, bytes: number): void {
  g.fetches[key] = (g.fetches[key] ?? 0) + 1;
  g.bytes += Math.max(0, bytes);
}

/** Count one successful download straight into storage (read, change,
 *  write), so passes that overlap never overwrite each other's counts. */
export function recordSuccessfulFetch(vaultId: string, key: string, bytes: number): void {
  const g = loadGuard(vaultId);
  recordFetch(g, key, bytes);
  saveGuard(vaultId, g);
}

/** "Continue syncing": lift today's budget pause for this vault. */
export function continueSyncingToday(vaultId: string): void {
  const g = loadGuard(vaultId);
  g.continued = true;
  saveGuard(vaultId, g);
}
