// Single source of truth for OS-dependent UI labels. Tauri's webview reports a
// normal per-OS userAgent (WebKit on macOS, WebView2/Chromium on Windows,
// WebKitGTK on Linux), so we can branch synchronously at module load without
// pulling in the os plugin — matching the long-standing check in
// shell/ModulePicker. NB: the keyboard *handlers* already fire on metaKey OR
// ctrlKey, so these labels are display-only.
const UA = typeof navigator !== "undefined" ? navigator.userAgent : "";

export const IS_MAC = /Mac/i.test(UA);
export const IS_WINDOWS = /Win/i.test(UA);

/** Primary command/control modifier label: "⌘" on macOS, "Ctrl" elsewhere. */
export const MOD_KEY = IS_MAC ? "⌘" : "Ctrl";

/** Render a Cmd/Ctrl shortcut for display: macOS "⌘K", others "Ctrl+K". */
export function shortcut(key: string | number): string {
  return IS_MAC ? `⌘${key}` : `Ctrl+${key}`;
}

/** What to call "this computer" in user copy: "Mac" / "PC" / "computer". */
export const DEVICE_NOUN = IS_MAC ? "Mac" : IS_WINDOWS ? "PC" : "computer";

/** What to call the OS file manager in user copy: "Finder" on macOS,
 *  "File Explorer" elsewhere. Backs the vault's reveal actions (the Rust
 *  `reveal_in_explorer` command handles both platforms). */
export const FILE_MANAGER = IS_MAC ? "Finder" : "File Explorer";
