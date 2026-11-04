import { describe, it, expect, vi } from "vitest";
import { keepSessionFreshWhenHidden } from "../../src/auth/keep-session-fresh";

function fakeClient() {
  const calls: string[] = [];
  let resolveInit!: () => void;
  const initDone = new Promise<void>((r) => { resolveInit = r; });
  const auth = {
    initialize: vi.fn(() => { calls.push("initialize"); return initDone.then(() => ({ error: null })); }),
    startAutoRefresh: vi.fn(async () => { calls.push("start"); }),
    stopAutoRefresh: vi.fn(async () => { calls.push("stop"); }),
  };
  return { client: { auth } as never, auth, calls, resolveInit };
}

describe("keepSessionFreshWhenHidden", () => {
  it("starts the always-on refresh only after initialize() has registered auth-js's hidden-tab listener", async () => {
    const { client, auth, calls, resolveInit } = fakeClient();
    keepSessionFreshWhenHidden(client);
    await Promise.resolve();
    expect(auth.startAutoRefresh).not.toHaveBeenCalled();
    resolveInit();
    await vi.waitFor(() => expect(auth.startAutoRefresh).toHaveBeenCalledTimes(1));
    expect(calls).toEqual(["initialize", "start"]);
  });

  it("stops refreshing on dispose, and never starts if disposed before init finishes", async () => {
    const a = fakeClient();
    const disposeA = keepSessionFreshWhenHidden(a.client);
    a.resolveInit();
    await vi.waitFor(() => expect(a.auth.startAutoRefresh).toHaveBeenCalled());
    disposeA();
    expect(a.auth.stopAutoRefresh).toHaveBeenCalledTimes(1);

    const b = fakeClient();
    const disposeB = keepSessionFreshWhenHidden(b.client);
    disposeB();
    b.resolveInit();
    await new Promise((r) => setTimeout(r, 0));
    expect(b.auth.startAutoRefresh).not.toHaveBeenCalled();
  });
});

describe("keepSessionFreshWhenHidden with the real auth-js", () => {
  it("keeps the refresh ticker running after the window is hidden", async () => {
    const { createSupabaseClient } = await import("@helios/auth");
    localStorage.clear();
    // The same factory AuthShell uses, so this covers Helios's real client config.
    const client = createSupabaseClient({ url: "http://127.0.0.1:9", anonKey: "anon" });
    const auth = client.auth as unknown as { autoRefreshTicker: unknown };
    const setHidden = (hidden: boolean) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
      window.dispatchEvent(new Event("visibilitychange"));
    };

    // Baseline: stock auth-js stops refreshing when hidden.
    await client.auth.initialize();
    setHidden(true);
    await vi.waitFor(() => expect(auth.autoRefreshTicker).toBeNull());

    setHidden(false);
    const dispose = keepSessionFreshWhenHidden(client);
    await vi.waitFor(() => expect(auth.autoRefreshTicker).not.toBeNull());
    setHidden(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(auth.autoRefreshTicker).not.toBeNull();
    dispose();
    await vi.waitFor(() => expect(auth.autoRefreshTicker).toBeNull());
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  });
});
