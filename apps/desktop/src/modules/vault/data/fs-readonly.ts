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
 * (no-ops if SOLIDWORKS isn't running or the file isn't open). Call ONLY on an
 * explicit single-file check-out / check-in / cancel — never in a bulk loop.
 */
export function flipSwReadonly(path: string, readonly: boolean): void {
  try {
    void invoke("sw_flip_readonly", { path, readonly }).catch(() => {});
  } catch {
    // Non-Tauri context (tests) — ignore.
  }
}
