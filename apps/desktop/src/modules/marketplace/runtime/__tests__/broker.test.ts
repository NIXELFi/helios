import { describe, it, expect, vi } from "vitest";
import type { PluginManifest, RpcRequest } from "@helios/plugin-sdk";
import { PluginBroker, type CallObservation } from "../broker";

function manifest(permissions: PluginManifest["permissions"]): PluginManifest {
  return {
    format: 1,
    id: "test.plugin",
    name: "Test",
    version: "1.0.0",
    entry: "dist/index.html",
    sdk: "^1.0.0",
    permissions,
  };
}

function req(method: string, params: unknown = {}): RpcRequest {
  return { kind: "helios:rpc", id: "1", method, params };
}

describe("PluginBroker", () => {
  it("allows Tier-0 methods with no permission declared", async () => {
    const handler = vi.fn(() => "ok");
    const broker = new PluginBroker({ manifest: manifest([]), handlers: { "host.log": handler } });
    const res = await broker.handle(req("host.log", { args: ["hi"] }));
    expect(res.ok).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("REJECTS a permissioned method the manifest did not declare — without running the handler", async () => {
    const handler = vi.fn();
    const broker = new PluginBroker({ manifest: manifest([]), handlers: { "file.read": handler } });
    const res = await broker.handle(req("file.read"));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("PermissionNotDeclared");
    expect(handler).not.toHaveBeenCalled(); // the security guarantee: no side effect
  });

  it("allows a declared permission and runs the handler", async () => {
    const handler = vi.fn(() => undefined);
    const broker = new PluginBroker({ manifest: manifest(["storage"]), handlers: { "storage.set": handler } });
    const res = await broker.handle(req("storage.set", { key: "k", value: 1 }));
    expect(res.ok).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("rejects a high-trust engine call when undeclared, even if a handler exists", async () => {
    const handler = vi.fn();
    const broker = new PluginBroker({
      manifest: manifest(["storage"]),
      handlers: { "engine.matlab.run": handler },
    });
    const res = await broker.handle(req("engine.matlab.run", { script: "1+1" }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("PermissionNotDeclared");
    expect(handler).not.toHaveBeenCalled();
  });

  it("maps an unknown method to UnknownMethod", async () => {
    const broker = new PluginBroker({ manifest: manifest([]), handlers: {} });
    const res = await broker.handle(req("fs.readAll"));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("UnknownMethod");
  });

  it("maps a thrown handler error to HandlerError and never throws", async () => {
    const broker = new PluginBroker({
      manifest: manifest(["storage"]),
      handlers: {
        "storage.set": () => {
          throw new Error("quota exceeded");
        },
      },
    });
    const res = await broker.handle(req("storage.set"));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("HandlerError");
      expect(res.error.message).toMatch(/quota/);
    }
  });

  it("records call observations for the review pipeline", async () => {
    const seen: CallObservation[] = [];
    const broker = new PluginBroker({
      manifest: manifest([]),
      handlers: { "host.log": () => undefined },
      onCall: (o) => seen.push(o),
    });
    await broker.handle(req("host.log"));
    await broker.handle(req("file.read")); // rejected
    expect(seen).toEqual([
      { method: "host.log", outcome: "ok" },
      { method: "file.read", outcome: "rejected", code: "PermissionNotDeclared" },
    ]);
  });
});
