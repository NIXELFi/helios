import { useCallback, useState } from "react";
import { open as openDirDialog } from "@tauri-apps/plugin-dialog";

const ROOT_KEY = "helios:kb:root";

function read(): string | null {
  try {
    return localStorage.getItem(ROOT_KEY);
  } catch {
    return null;
  }
}

/**
 * Persisted path to the external Obsidian-style vault folder. The data stays
 * on disk (nothing copied into Helios) — we only remember which folder to read.
 */
export function useVaultRoot() {
  const [root, setRoot] = useState<string | null>(read);

  const pick = useCallback(async (): Promise<string | null> => {
    const chosen = await openDirDialog({
      directory: true,
      multiple: false,
      title: "Select your knowledge-base folder",
    });
    if (typeof chosen === "string") {
      try {
        localStorage.setItem(ROOT_KEY, chosen);
      } catch {
        /* ignore */
      }
      setRoot(chosen);
      return chosen;
    }
    return null;
  }, []);

  const clear = useCallback(() => {
    try {
      localStorage.removeItem(ROOT_KEY);
    } catch {
      /* ignore */
    }
    setRoot(null);
  }, []);

  return { root, pick, clear };
}
