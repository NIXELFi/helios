import { invoke } from "@tauri-apps/api/core";

// Tauri has no handler for new-window requests, so a plain
// `<a href="https://…" target="_blank">` does nothing on macOS (WKWebView drops
// it) and opens a bare webview window on Windows. Route every external http(s)
// link click through the Rust `open_external_url` command instead, so links open
// in the user's default browser on every platform. Outside the desktop shell
// (vite in a browser, jsdom tests) links keep their normal behavior.

const inTauri = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** The http(s) URL an anchor points at, if it leaves the app; otherwise null. */
export function externalHref(anchor: HTMLAnchorElement): string | null {
  const raw = anchor.getAttribute("href");
  if (!raw || raw.startsWith("#")) return null;
  let url: URL;
  try {
    url = new URL(raw, window.location.href);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.origin === window.location.origin) return null;
  return url.href;
}

/** Open `url` in the system browser (best-effort; falls back to window.open). */
export function openExternal(url: string): void {
  if (!inTauri()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  void invoke("open_external_url", { url }).catch(() => {});
}

function onClick(e: MouseEvent): void {
  // Runs after React's root listener, so a component that already handled the
  // click (wiki links, cell selection, …) wins.
  if (e.defaultPrevented || (e.button !== 0 && e.button !== 1)) return;
  const anchor = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (!anchor || anchor.hasAttribute("download")) return;
  const url = externalHref(anchor);
  if (!url) return;
  e.preventDefault();
  openExternal(url);
}

let installed = false;

/** Install once at boot. No-op outside the Tauri shell. Returns an uninstaller. */
export function installExternalLinkHandler(): () => void {
  if (installed || !inTauri()) return () => {};
  installed = true;
  document.addEventListener("click", onClick);
  document.addEventListener("auxclick", onClick);
  return () => {
    installed = false;
    document.removeEventListener("click", onClick);
    document.removeEventListener("auxclick", onClick);
  };
}
