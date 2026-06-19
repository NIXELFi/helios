/**
 * Shared context for the vault watch set.
 *
 * A single useWatchedFiles instance is owned by VaultHome and published here so
 * that any descendant — currently FileDetailPanel (star button) and VaultHome
 * itself (notification feed) — can read/write the same React state without
 * introducing a second independent instance backed by the same localStorage key.
 *
 * Without this context, toggling the star in FileDetailPanel updates
 * BrowseScreen's local instance but NOT VaultHome's, so useNotifications never
 * sees newly-watched files until a full vault reload (HIGH defect).
 */
import { createContext, useContext } from "react";
import type { UseWatchedFiles } from "./useWatchedFiles";

export const WatchedFilesContext = createContext<UseWatchedFiles | null>(null);

/** Returns the shared watch-set context.  Throws if called outside VaultHome. */
export function useWatchedFilesContext(): UseWatchedFiles {
  const ctx = useContext(WatchedFilesContext);
  if (!ctx) {
    throw new Error(
      "useWatchedFilesContext must be used inside <WatchedFilesContext.Provider> (rendered by VaultHome)",
    );
  }
  return ctx;
}
