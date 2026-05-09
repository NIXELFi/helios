import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "helios.vault.localFolder";

export function useVaultFolder() {
  const [path, setPathState] = useState<string | null>(() => {
    try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
  });

  // Sync across tabs / windows.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setPathState(e.newValue);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setPath = useCallback((next: string | null) => {
    if (next === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
    setPathState(next);
  }, []);

  const clear = useCallback(() => setPath(null), [setPath]);

  return { path, setPath, clear };
}
