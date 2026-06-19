/**
 * localStorage-backed watch set for vault files.
 *
 * Key: `helios.vault-watch.<vaultId>`
 * Value: JSON array of fileId strings.
 *
 * Reactive: toggling a file immediately updates React state so UI re-renders.
 */
import { useCallback, useEffect, useState } from "react";
import type { FileId, VaultId } from "./types";

function storageKey(vaultId: VaultId): string {
  return `helios.vault-watch.${vaultId}`;
}

function load(vaultId: VaultId): Set<FileId> {
  try {
    const raw = localStorage.getItem(storageKey(vaultId));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return new Set(parsed as FileId[]);
  } catch {
    // corrupt storage — start fresh
  }
  return new Set();
}

function save(vaultId: VaultId, watched: Set<FileId>): void {
  try {
    localStorage.setItem(storageKey(vaultId), JSON.stringify([...watched]));
  } catch {
    // storage quota exceeded — ignore silently
  }
}

export interface UseWatchedFiles {
  watched: Set<FileId>;
  isWatched: (fileId: FileId) => boolean;
  watch: (fileId: FileId) => void;
  unwatch: (fileId: FileId) => void;
  toggle: (fileId: FileId) => void;
}

export function useWatchedFiles(vaultId: VaultId | undefined): UseWatchedFiles {
  const [watched, setWatched] = useState<Set<FileId>>(() =>
    vaultId ? load(vaultId) : new Set(),
  );

  // If the vault changes (e.g. vault switcher), reload from storage.
  useEffect(() => {
    setWatched(vaultId ? load(vaultId) : new Set());
  }, [vaultId]);

  const watch = useCallback(
    (fileId: FileId) => {
      setWatched((prev) => {
        if (prev.has(fileId)) return prev;
        const next = new Set(prev);
        next.add(fileId);
        if (vaultId) save(vaultId, next);
        return next;
      });
    },
    [vaultId],
  );

  const unwatch = useCallback(
    (fileId: FileId) => {
      setWatched((prev) => {
        if (!prev.has(fileId)) return prev;
        const next = new Set(prev);
        next.delete(fileId);
        if (vaultId) save(vaultId, next);
        return next;
      });
    },
    [vaultId],
  );

  const toggle = useCallback(
    (fileId: FileId) => {
      setWatched((prev) => {
        const next = new Set(prev);
        if (next.has(fileId)) next.delete(fileId);
        else next.add(fileId);
        if (vaultId) save(vaultId, next);
        return next;
      });
    },
    [vaultId],
  );

  const isWatched = useCallback((fileId: FileId) => watched.has(fileId), [watched]);

  return { watched, isWatched, watch, unwatch, toggle };
}
