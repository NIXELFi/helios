// Pure aggregation of a vault's files/folders/locks/users into the datasets the
// Insights charts render. Kept free of React + Supabase so it can be unit-tested
// directly (see __tests__/vaultStats.test.ts) and so the screen is a thin shell.

import type { Folder, Lock, VaultFile, VaultUser } from "../data/types";

export interface Slice {
  label: string;
  value: number;
  /** Secondary metric shown in the legend (e.g. bytes behind a by-count slice). */
  extra?: number;
}
export interface Bar {
  label: string;
  value: number;
  sublabel?: string;
}
export interface Column {
  label: string;
  value: number;
}

export interface VaultInsights {
  totalFiles: number;
  totalBytes: number;
  totalVersions: number;
  folderCount: number;
  activeCheckouts: number;
  revisionedFiles: number;
  avgBytes: number;
  byType: Slice[];
  storageByArea: Bar[];
  addedByMonth: Column[];
  revisionDist: Column[];
  topContributors: Bar[];
  largestFiles: Bar[];
}

const TOP_N = 8;

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "(no ext)";
  return name.slice(dot + 1).toLowerCase();
}

/** Walk a file's folder chain to the top-level folder name ("area"). Files at
 *  the vault root bucket as "(root)"; a dangling folder_id as "(unknown)". */
function topAreaOf(folderId: string | null, byId: Map<string, Folder>): string {
  if (!folderId) return "(root)";
  let cur = byId.get(folderId);
  if (!cur) return "(unknown)";
  const seen = new Set<string>();
  while (cur.parent_id && !seen.has(cur.id)) {
    seen.add(cur.id);
    const parent = byId.get(cur.parent_id);
    if (!parent) break;
    cur = parent;
  }
  return cur.name;
}

function monthKey(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Roll a `Map<label, value>` into a sorted Top-N list, folding the remainder
 *  into a single "Other (k)" bucket so a long tail never crowds the chart. */
function topNBars(
  counts: Map<string, number>,
  n = TOP_N,
  subOf?: (label: string) => string | undefined,
): Bar[] {
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const head: Bar[] = sorted.slice(0, n).map(([label, value]) => ({ label, value, sublabel: subOf?.(label) }));
  const rest = sorted.slice(n);
  if (rest.length > 0) {
    const sum = rest.reduce((acc, [, v]) => acc + v, 0);
    head.push({ label: `Other (${rest.length})`, value: sum });
  }
  return head;
}

/** Author display label resolution: prefer display name, then email, then a
 *  short id; a null author (e.g. imported content) reads as "Unknown". */
function authorLabel(id: string | null, users: Map<string, VaultUser>): string {
  if (!id) return "Unknown";
  const u = users.get(id);
  return u?.display_name ?? u?.email ?? `${id.slice(0, 8)}…`;
}

export function computeVaultInsights(
  files: VaultFile[],
  folders: Folder[],
  locks: Lock[],
  users: VaultUser[],
): VaultInsights {
  const folderById = new Map(folders.map((f) => [f.id, f]));
  const userById = new Map(users.map((u) => [u.user_id, u]));

  let totalBytes = 0;
  let totalVersions = 0;
  let revisionedFiles = 0;

  const typeCount = new Map<string, number>();
  const typeBytes = new Map<string, number>();
  const areaBytes = new Map<string, number>();
  const monthCount = new Map<string, number>();
  const contributor = new Map<string, number>();
  const revBuckets = new Map<string, number>([
    ["1", 0], ["2", 0], ["3", 0], ["4", 0], ["5+", 0],
  ]);

  for (const f of files) {
    const size = f.latest?.size_bytes ?? 0;
    const versions = f.latest?.version_num ?? 0;
    totalBytes += size;
    totalVersions += versions;
    if (f.latest?.revision != null) revisionedFiles += 1;

    const ext = extOf(f.name);
    typeCount.set(ext, (typeCount.get(ext) ?? 0) + 1);
    typeBytes.set(ext, (typeBytes.get(ext) ?? 0) + size);

    const area = topAreaOf(f.folder_id, folderById);
    areaBytes.set(area, (areaBytes.get(area) ?? 0) + size);

    const mk = monthKey(f.created_at);
    if (mk) monthCount.set(mk, (monthCount.get(mk) ?? 0) + 1);

    const a = authorLabel(f.latest?.author_id ?? null, userById);
    contributor.set(a, (contributor.get(a) ?? 0) + 1);

    if (versions >= 1) {
      const bucket = versions >= 5 ? "5+" : String(versions);
      revBuckets.set(bucket, (revBuckets.get(bucket) ?? 0) + 1);
    }
  }

  // File-type donut: top types by count, remainder folded into "Other".
  const typeSorted = [...typeCount.entries()].sort((a, b) => b[1] - a[1]);
  const byType: Slice[] = typeSorted.slice(0, TOP_N).map(([label, value]) => ({
    label,
    value,
    extra: typeBytes.get(label) ?? 0,
  }));
  const typeRest = typeSorted.slice(TOP_N);
  if (typeRest.length > 0) {
    byType.push({
      label: `Other (${typeRest.length})`,
      value: typeRest.reduce((a, [, v]) => a + v, 0),
      extra: typeRest.reduce((a, [l]) => a + (typeBytes.get(l) ?? 0), 0),
    });
  }

  // Added-by-month: gap-fill every month between first and last so a quiet
  // stretch reads as a real gap, not a missing bar.
  const addedByMonth = fillMonths(monthCount);

  const revisionDist: Column[] = [...revBuckets.entries()].map(([label, value]) => ({ label, value }));

  const largestFiles: Bar[] = [...files]
    .filter((f) => (f.latest?.size_bytes ?? 0) > 0)
    .sort((a, b) => (b.latest?.size_bytes ?? 0) - (a.latest?.size_bytes ?? 0))
    .slice(0, TOP_N)
    .map((f) => ({ label: f.name, value: f.latest?.size_bytes ?? 0 }));

  return {
    totalFiles: files.length,
    totalBytes,
    totalVersions,
    folderCount: folders.length,
    activeCheckouts: locks.length,
    revisionedFiles,
    avgBytes: files.length > 0 ? totalBytes / files.length : 0,
    byType,
    storageByArea: topNBars(areaBytes),
    addedByMonth,
    revisionDist,
    topContributors: topNBars(contributor),
    largestFiles,
  };
}

/** Expand a `YYYY-MM → count` map into a dense, chronological column series,
 *  inserting zero months for any gap between the earliest and latest entry. */
export function fillMonths(monthCount: Map<string, number>): Column[] {
  if (monthCount.size === 0) return [];
  const keys = [...monthCount.keys()].sort();
  const [fy, fm] = keys[0]!.split("-").map(Number);
  const [ly, lm] = keys[keys.length - 1]!.split("-").map(Number);
  const out: Column[] = [];
  let y = fy!;
  let m = fm!;
  // Hard cap so a multi-year vault can't emit hundreds of bars.
  for (let guard = 0; guard < 240; guard++) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    out.push({ label: key, value: monthCount.get(key) ?? 0 });
    if (y === ly && m === lm) break;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}
