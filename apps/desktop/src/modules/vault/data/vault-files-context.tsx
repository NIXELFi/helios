import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useAllFiles, type VaultFiles } from "./useAllFiles";
import type { FolderId, VaultFile, VaultId } from "./types";

/**
 * ONE whole-vault file catalog per Vault module tree.
 *
 * The 2026-09-09 load audit measured the catalog page (files + latest embed,
 * 1000 rows/page) at 30% of ALL database time — 2.19 M calls, ~17.5 k a day —
 * because it was fetched twice over: VaultHome ran `useAllFiles` for the
 * notification feed's fileId → name map, and BrowseScreen ran a second copy for
 * the file table, auto-sync and unmatched-local detection. On SDM25 (8,627
 * files) that is two multi-megabyte pulls for the same rows.
 *
 * VaultHome now provides a single instance here and every screen reads it. The
 * per-folder query (the old `useFiles`) is gone too: a folder view is a filter
 * over this list, and a mutation refreshes just that folder through
 * `refreshFolder`.
 */
const VaultFilesContext = createContext<VaultFiles | null>(null);

export function VaultFilesProvider({
  vaultId,
  children,
}: {
  vaultId: VaultId | undefined;
  children: ReactNode;
}) {
  const files = useAllFiles(vaultId);
  return <VaultFilesContext.Provider value={files}>{children}</VaultFilesContext.Provider>;
}

/**
 * The shared catalog. Throws outside a provider ON PURPOSE: silently falling
 * back to a private `useAllFiles` is exactly the duplicate pull this context
 * exists to remove, and it would come back invisibly the next time a screen was
 * mounted somewhere new.
 */
export function useVaultFiles(): VaultFiles {
  const ctx = useContext(VaultFilesContext);
  if (!ctx) {
    throw new Error("useVaultFiles must be used inside a <VaultFilesProvider> (see VaultHome)");
  }
  return ctx;
}

/**
 * The live files of ONE folder (`null` = the vault root), derived from the
 * shared catalog — no second query. Sorted by name then id so the order is
 * deterministic and identical whichever way a row got into the list (the
 * catalog itself is ordered by id for safe pagination). Returns null while the
 * catalog is still loading, which is the caller's "nothing to show yet" state.
 */
export function useFolderFiles(folderId: FolderId | null): VaultFile[] | null {
  const { data } = useVaultFiles();
  return useMemo(() => {
    if (data === null) return null;
    return data
      .filter((f) => (f.folder_id ?? null) === folderId && f.deleted_at == null)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }, [data, folderId]);
}
