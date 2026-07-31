// The plugin data vault's isolation properties: one plugin can't read another's
// keys (already true), and — the audit fix — one MEMBER can't read another's on a
// shared shop machine, and uninstall really does erase what it says it erases.

import { describe, it, expect, beforeEach } from "vitest";
import type { PluginManifest } from "@helios/plugin-sdk";
import { makeHandlers } from "../capabilityHandlers";
import { pluginStorageNamespace, purgePluginStorage } from "../pluginStorage";

function manifest(id: string): PluginManifest {
  return {
    format: 1,
    id,
    name: id,
    version: "1.0.0",
    entry: "dist/index.html",
    sdk: "^1.0.0",
    permissions: ["storage"],
  };
}

function handlersFor(pluginId: string, userId: string | null) {
  return makeHandlers(manifest(pluginId), {
    log: () => {},
    notify: () => {},
    userId,
  });
}

beforeEach(() => localStorage.clear());

// Three plugins are live in prod under the pre-namespacing key layout, so the
// migration is what stops namespacing reading as "the add-on forgot everything".
describe("legacy (pre-namespacing) plugin storage", () => {
  const legacyKey = (pluginId: string, k: string) => `helios:plugin-storage:${pluginId}:${k}`;

  it("is adopted into the first member who opens the add-on", async () => {
    localStorage.setItem(legacyKey("aero.tool", "rake"), "3");

    const h = handlersFor("aero.tool", "user-a");
    expect(await h["storage.get"]!({ key: "rake" })).toBe(3);
    // ...and the old key is gone, so it can't be adopted twice or linger.
    expect(localStorage.getItem(legacyKey("aero.tool", "rake"))).toBeNull();
  });

  it("never overwrites a value the member already has", async () => {
    const h = handlersFor("aero.tool", "user-a");
    await h["storage.set"]!({ key: "rake", value: 9 });
    localStorage.setItem(legacyKey("aero.tool", "rake"), "3");

    const again = handlersFor("aero.tool", "user-a");
    expect(await again["storage.get"]!({ key: "rake" })).toBe(9);
  });

  it("is erased by uninstall, so 'stored data is erased' is not a lie", () => {
    localStorage.setItem(legacyKey("aero.tool", "rake"), "3");

    purgePluginStorage("user-a", "aero.tool");
    expect(localStorage.getItem(legacyKey("aero.tool", "rake"))).toBeNull();
  });

  it("is not confused with another plugin's namespaced keys", async () => {
    const other = handlersFor("aero.other", "user-a");
    await other["storage.set"]!({ key: "keep", value: 1 });
    localStorage.setItem(legacyKey("aero.tool", "rake"), "3");

    handlersFor("aero.tool", "user-a");
    expect(await other["storage.get"]!({ key: "keep" })).toBe(1);
  });
});

describe("plugin storage namespacing", () => {
  it("keys by user id as well as plugin id", async () => {
    const h = handlersFor("aero.tool", "user-a");
    await h["storage.set"]!({ key: "rake", value: 3 });

    expect(localStorage.getItem(`${pluginStorageNamespace("user-a", "aero.tool")}rake`)).toBe("3");
  });

  it("does not leak one member's values to the next member on the same machine", async () => {
    const a = handlersFor("aero.tool", "user-a");
    await a["storage.set"]!({ key: "rake", value: 3 });

    // Member A signs out, member B signs in and opens the SAME add-on.
    const b = handlersFor("aero.tool", "user-b");
    expect(await b["storage.get"]!({ key: "rake" })).toBeNull();
    expect(await b["storage.keys"]!({})).toEqual([]);

    // ...and A's values are untouched by B writing its own.
    await b["storage.set"]!({ key: "rake", value: 9 });
    expect(await a["storage.get"]!({ key: "rake" })).toBe(3);
  });

  it("still isolates two plugins belonging to the same member", async () => {
    const one = handlersFor("aero.tool", "user-a");
    const two = handlersFor("suspension.tool", "user-a");
    await one["storage.set"]!({ key: "k", value: "one" });

    expect(await two["storage.get"]!({ key: "k" })).toBeNull();
    expect(await one["storage.keys"]!({})).toEqual(["k"]);
  });

  it("fails closed when there is no signed-in member", () => {
    const h = handlersFor("aero.tool", null);
    expect(() => h["storage.set"]!({ key: "k", value: 1 })).toThrow(/signed out/i);
    expect(() => h["storage.get"]!({ key: "k" })).toThrow(/signed out/i);
  });

  it("counts the quota only against the same member's own keys", async () => {
    const a = handlersFor("aero.tool", "user-a");
    // ~0.9 MB for member A leaves member B's fresh namespace unaffected.
    await a["storage.set"]!({ key: "big", value: "x".repeat(900_000) });
    const b = handlersFor("aero.tool", "user-b");
    expect(() => b["storage.set"]!({ key: "big", value: "y".repeat(900_000) })).not.toThrow();
  });
});

describe("purgePluginStorage", () => {
  it("erases only that member's copy of that plugin", async () => {
    await handlersFor("aero.tool", "user-a")["storage.set"]!({ key: "k", value: 1 });
    await handlersFor("aero.tool", "user-b")["storage.set"]!({ key: "k", value: 2 });
    await handlersFor("suspension.tool", "user-a")["storage.set"]!({ key: "k", value: 3 });

    purgePluginStorage("user-a", "aero.tool");

    expect(await handlersFor("aero.tool", "user-a")["storage.get"]!({ key: "k" })).toBeNull();
    expect(await handlersFor("aero.tool", "user-b")["storage.get"]!({ key: "k" })).toBe(2);
    expect(await handlersFor("suspension.tool", "user-a")["storage.get"]!({ key: "k" })).toBe(3);
  });
});
