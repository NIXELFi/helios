import { invoke } from "@tauri-apps/api/core";

/**
 * Toggle the OS read-only bit on a local file via the `set_path_readonly` app
 * command (Rust). Backs the Vault's real-vault model: a local working copy is
 * read-only unless the file is checked out by the current user.
 *
 * Best-effort: a permissions hiccup must never break a download / check-out /
 * check-in flow, so failures are logged and swallowed rather than thrown.
 */
export async function setReadonly(path: string, readonly: boolean): Promise<void> {
  try {
    await invoke("set_path_readonly", { path, readonly });
  } catch (e) {
    console.warn(`[vault] set_path_readonly(${path}, ${readonly}) failed:`, e);
  }
}

/**
 * Flip an OPEN SOLIDWORKS document's in-session read-only state to match a
 * check-out change, via the out-of-process helper (`sw_flip_readonly`). The
 * on-disk bit (setReadonly above) only governs the NEXT open; this makes an
 * already-open file editable on check-out / re-protected on check-in WITHOUT
 * the SOLIDWORKS add-in. Best-effort + fire-and-forget — never blocks or throws
 * (no-ops if SOLIDWORKS isn't running or the file isn't open).
 *
 * Every call is a helper PROCESS on the native side, so calls go through a
 * serial queue: at most one in flight (the command resolves when the helper
 * exits), and a path queued again before its turn keeps only the latest desired
 * state. A 300-file bulk check-out therefore costs at most 300 sequential
 * launches in the worst case and usually far fewer, never 300 at once.
 */
export function flipSwReadonly(path: string, readonly: boolean): void {
  // Re-setting an existing key keeps its queue position and replaces the state.
  swFlipQueue.set(path, readonly);
  if (!swFlipDraining) void drainSwFlips();
}

const swFlipQueue = new Map<string, boolean>();
let swFlipDraining = false;

async function drainSwFlips(): Promise<void> {
  swFlipDraining = true;
  try {
    while (swFlipQueue.size > 0) {
      const [path, readonly] = swFlipQueue.entries().next().value as [string, boolean];
      swFlipQueue.delete(path);
      try {
        await invoke("sw_flip_readonly", { path, readonly });
      } catch {
        // Non-Tauri context (tests) or the helper failed: best-effort, move on.
      }
    }
  } finally {
    swFlipDraining = false;
  }
}
