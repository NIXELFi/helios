import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import type { SupabaseClient } from "@helios/auth";
import type { ReactNode } from "react";
import {
  useAvailablePlugins,
  useInstalledPlugins,
  useInstall,
} from "../data/useMarketplace";

// Capture Tauri invoke calls without a real Tauri runtime.
const invokeMock = vi.fn(async () => undefined);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

interface RpcResult {
  data: unknown;
  error: { message: string } | null;
}
type RpcHandler = (name: string, args?: Record<string, unknown>) => RpcResult;

function mockClient(opts: {
  rpc: RpcHandler;
  signedUrl?: string;
}): { client: SupabaseClient; rpc: ReturnType<typeof vi.fn>; createSignedUrl: ReturnType<typeof vi.fn> } {
  const rpc = vi.fn(async (name: string, args?: Record<string, unknown>) => opts.rpc(name, args));
  const createSignedUrl = vi.fn(async () => ({
    data: { signedUrl: opts.signedUrl ?? "https://signed.example/bundle" },
    error: null,
  }));
  const client = {
    auth: {
      getSession: vi
        .fn()
        .mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    schema: () => ({ rpc }),
    storage: { from: () => ({ createSignedUrl }) },
  } as unknown as SupabaseClient;
  return { client, rpc, createSignedUrl };
}

const wrap = (c: SupabaseClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <SupabaseAuthProvider client={c}>{children}</SupabaseAuthProvider>;
  };

const ROW = {
  id: "aero.downforce",
  name: "Downforce Calculator",
  subteam: "st-aero",
  is_recommended: true,
  version: "1.0.0",
  manifest: { format: 1, id: "aero.downforce", name: "Downforce Calculator", version: "1.0.0", entry: "dist/index.html", sdk: "^1.0.0", permissions: [] },
  permissions: [],
  installed_version: null,
  published_at: "2026-06-26T00:00:00Z",
};

beforeEach(() => {
  invokeMock.mockClear();
});

describe("useAvailablePlugins", () => {
  it("maps snake_case rows to camelCase plugins", async () => {
    const { client } = mockClient({
      rpc: (name) => (name === "list_available_plugins" ? { data: [ROW], error: null } : { data: [], error: null }),
    });
    const { result } = renderHook(() => useAvailablePlugins(), { wrapper: wrap(client) });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.plugins).toHaveLength(1);
    expect(result.current.plugins[0]).toMatchObject({
      id: "aero.downforce",
      isRecommended: true,
      installedVersion: null,
      version: "1.0.0",
    });
  });

  it("surfaces an RPC error", async () => {
    const { client } = mockClient({ rpc: () => ({ data: null, error: { message: "boom" } }) });
    const { result } = renderHook(() => useAvailablePlugins(), { wrapper: wrap(client) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("boom");
  });
});

describe("useInstalledPlugins", () => {
  it("returns only rows with an installed version", async () => {
    const { client } = mockClient({
      rpc: (name) =>
        name === "list_available_plugins"
          ? { data: [ROW, { ...ROW, id: "x.y", installed_version: "2.0.0" }], error: null }
          : { data: [], error: null },
    });
    const { result } = renderHook(() => useInstalledPlugins(), { wrapper: wrap(client) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.plugins.map((p) => p.id)).toEqual(["x.y"]);
  });
});

describe("useInstall", () => {
  it("records the install, signs the bundle URL, fetches the key, then invokes Rust with the verify metadata", async () => {
    const calls: string[] = [];
    const { client } = mockClient({
      rpc: (name) => {
        calls.push(name);
        if (name === "install_plugin") {
          return {
            data: [
              {
                plugin_id: "aero.downforce",
                version: "1.0.0",
                manifest: ROW.manifest,
                bundle_sha256: "a".repeat(64),
                bundle_bytes: 2048,
                signature: "c2ln",
                sig_alg: "ed25519",
                signing_key_id: "deadbeef",
              },
            ],
            error: null,
          };
        }
        if (name === "signing_public_key") {
          return { data: [{ key_id: "deadbeef", public_key: "cHVi", alg: "ed25519" }], error: null };
        }
        return { data: [], error: null };
      },
    });

    const { result } = renderHook(() => useInstall(), { wrapper: wrap(client) });
    await act(async () => {
      await result.current.install({ id: "aero.downforce", version: "1.0.0" });
    });

    expect(calls).toEqual(["install_plugin", "signing_public_key"]);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("install_plugin_bundle", {
      pluginId: "aero.downforce",
      version: "1.0.0",
      signedUrl: "https://signed.example/bundle",
      expectedSha256: "a".repeat(64),
      bundleBytes: 2048,
      signature: "c2ln",
      sigAlg: "ed25519",
      publicKey: "cHVi",
    });
  });

  it("aborts (no Rust invoke) when install_plugin rejects an unapproved version", async () => {
    const { client } = mockClient({
      rpc: (name) =>
        name === "install_plugin"
          ? { data: null, error: { message: "not installable" } }
          : { data: [], error: null },
    });
    const { result } = renderHook(() => useInstall(), { wrapper: wrap(client) });
    await act(async () => {
      await expect(result.current.install({ id: "x", version: "9.9.9" })).rejects.toThrow("not installable");
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
