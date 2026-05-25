import { useCallback, useEffect, useState } from "react";

// The user picks ONE root directory ("Helios folder"); each vault then
// transparently syncs into a `<root>/<vault.name>` subfolder. SDM26 and
// SDM27 stay isolated on disk while sharing the same parent, so a single
// pick covers every vault the user has access to.
//
// Storage: a single string at this key.
//
// Legacy: prior versions stored either a bare string (vN.x) or a JSON map
// `{ [vaultId]: path }` (v3.5.x). When we encounter either of those at
// startup we extract a likely root by taking the common parent of the
// stored paths, or — for a single entry — using that entry's parent.
const STORAGE_KEY = "helios.vault.localFolder";

function readRoot(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    // New shape: a bare string IS the root. The legacy bare-string from
    // v2.x also looks like this — we treat it as the root directly (the
    // user can re-pick if it's wrong).
    if (!raw.startsWith("{")) return raw;
    // Legacy v3.5.x shape: JSON map { [vaultId]: path }. Best-effort
    // recovery: take the parent directory of any one path. Users were
    // expected to pick the same parent for both vaults anyway.
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        const first = Object.values(obj).find((v) => typeof v === "string") as string | undefined;
        if (first) {
          const idx = first.lastIndexOf("/");
          return idx > 0 ? first.slice(0, idx) : first;
        }
      }
    } catch { /* fall through */ }
    return null;
  } catch { return null; }
}

function writeRoot(value: string | null) {
  try {
    if (value === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, value);
  } catch { /* private mode etc. */ }
}

// Filesystem-safe vault-name → subfolder. The team's vault names today
// (SDM25/26/27) are all already safe; this is defensive for future names.
export function sanitizeVaultName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, "_").trim() || "vault";
}

function joinPath(root: string, sub: string): string {
  const trimmed = root.replace(/\/+$/, "");
  return `${trimmed}/${sub}`;
}

// Same-window subscriber set so setRoot in one component is visible to
// useVaultFolder consumers in sibling components without remounting.
type Sub = (next: string | null) => void;
const subs = new Set<Sub>();
function broadcast(next: string | null) {
  for (const s of subs) s(next);
}

/**
 * Resolves the per-vault working directory.
 *
 * The user picks ONE root via `setRoot`. The hook returns the effective
 * path for the given vault as `<root>/<sanitize(vaultName)>`. If the root
 * isn't set or the vault name is unknown, `path` is null and callers
 * (e.g. `useLocalFolderScan`) skip work.
 *
 * The `root` value is shared across every useVaultFolder instance in the
 * window via a module-level subscriber set, so picking a folder in
 * Settings updates BrowseScreen / auto-sync immediately.
 */
export function useVaultFolder(arg: { vaultName: string | null } | null): {
  /** Shared root directory the user picked. */
  root: string | null;
  /** Effective per-vault path (`<root>/<sanitize(vaultName)>`), or null. */
  path: string | null;
  /** Updates the shared root. */
  setRoot: (next: string | null) => void;
  /** Clears the shared root. */
  clear: () => void;
} {
  const [root, setRootState] = useState<string | null>(() => readRoot());

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setRootState(readRoot());
    };
    const sub: Sub = (next) => setRootState(next);
    window.addEventListener("storage", onStorage);
    subs.add(sub);
    return () => {
      window.removeEventListener("storage", onStorage);
      subs.delete(sub);
    };
  }, []);

  const vaultName = arg?.vaultName ?? null;
  const path = root && vaultName ? joinPath(root, sanitizeVaultName(vaultName)) : null;

  const setRoot = useCallback((next: string | null) => {
    writeRoot(next);
    setRootState(next);
    broadcast(next);
  }, []);

  const clear = useCallback(() => setRoot(null), [setRoot]);

  return { root, path, setRoot, clear };
}
