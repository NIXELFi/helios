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
