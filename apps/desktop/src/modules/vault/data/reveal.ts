import { invoke } from "@tauri-apps/api/core";

/**
 * Ask the OS file manager to reveal `absPath` with the file pre-selected.
 * On Windows: `explorer /select,<path>`. On macOS: `open -R <path>`.
 * Returns true on success, false on error (non-existent path, unsupported
 * platform, spawn failure). Errors are console.warn-ed, not thrown.
 */
export async function revealInExplorer(absPath: string): Promise<boolean> {
  try {
    await invoke("reveal_in_explorer", { path: absPath });
    return true;
  } catch (e) {
    console.warn("[reveal] reveal_in_explorer failed:", e);
    return false;
  }
}
