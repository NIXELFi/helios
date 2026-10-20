import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(() => Promise.resolve());
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...(a as [])) }));

function anchor(href: string, attrs: Record<string, string> = {}): HTMLAnchorElement {
  const a = document.createElement("a");
  a.setAttribute("href", href);
  a.setAttribute("target", "_blank");
  for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
  a.textContent = "link";
  document.body.appendChild(a);
  return a;
}

function click(el: Element, init: MouseEventInit = {}): MouseEvent {
  const e = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  el.dispatchEvent(e);
  return e;
}

let uninstall: () => void = () => {};

describe("external links", () => {
  beforeEach(() => {
    vi.resetModules();
    invoke.mockClear();
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  });
  afterEach(() => {
    uninstall();
    document.body.innerHTML = "";
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("routes an external target=_blank link to open_external_url (the Agora product link)", async () => {
    const { installExternalLinkHandler } = await import("../external-links");
    uninstall = installExternalLinkHandler();
    const e = click(anchor("https://www.mcmaster.com/91251A540/"));
    expect(e.defaultPrevented).toBe(true);
    expect(invoke).toHaveBeenCalledWith("open_external_url", { url: "https://www.mcmaster.com/91251A540/" });
  });

  it("handles a click on a child element of the link", async () => {
    const { installExternalLinkHandler } = await import("../external-links");
    uninstall = installExternalLinkHandler();
    const a = anchor("https://example.com/x");
    const span = document.createElement("span");
    a.appendChild(span);
    click(span);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("leaves in-app, hash, non-http and already-handled links alone", async () => {
    const { installExternalLinkHandler } = await import("../external-links");
    uninstall = installExternalLinkHandler();
    click(anchor("#"));
    click(anchor("/settings"));
    click(anchor("mailto:someone@asu.edu"));
    click(anchor("javascript:alert(1)"));
    click(anchor("https://example.com/file.csv", { download: "" }));
    const handled = anchor("https://example.com/wiki");
    handled.addEventListener("click", (e) => e.preventDefault());
    click(handled);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("is a no-op outside the Tauri shell", async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    const { installExternalLinkHandler } = await import("../external-links");
    uninstall = installExternalLinkHandler();
    const e = click(anchor("https://example.com"));
    expect(e.defaultPrevented).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});
