import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { SupabaseAuthProvider } from "@helios/auth";
import type { SupabaseClient } from "@helios/auth";
import type { ReactNode } from "react";
import { useReviewQueue, useReviewVersion } from "../data/useReview";

function mockClient(rpc: (name: string, args?: Record<string, unknown>) => { data: unknown; error: { message: string } | null }) {
  const rpcMock = vi.fn(async (name: string, args?: Record<string, unknown>) => rpc(name, args));
  const client = {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: { user: { id: "u1" } } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    schema: () => ({ rpc: rpcMock }),
  } as unknown as SupabaseClient;
  return { client, rpcMock };
}

const wrap = (c: SupabaseClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <SupabaseAuthProvider client={c}>{children}</SupabaseAuthProvider>;
  };

const QUEUE_ROW = {
  plugin_id: "aero.x",
  name: "Aero X",
  subteam: "st-aero",
  version: "1.0.0",
  manifest: { format: 1, id: "aero.x", name: "Aero X", version: "1.0.0", entry: "dist/index.html", sdk: "^1.0.0", permissions: ["storage"] },
  permissions: ["storage"],
  review_report: null,
  bundle_sha256: "a".repeat(64),
  bundle_bytes: 1024,
  published_by: "u2",
  published_at: "2026-06-26T00:00:00Z",
};

describe("useReviewQueue", () => {
  it("maps queue rows to camelCase items", async () => {
    const { client } = mockClient((name) =>
      name === "review_queue" ? { data: [QUEUE_ROW], error: null } : { data: [], error: null },
    );
    const { result } = renderHook(() => useReviewQueue(), { wrapper: wrap(client) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.queue).toHaveLength(1);
    expect(result.current.queue[0]).toMatchObject({
      pluginId: "aero.x",
      bundleSha256: "a".repeat(64),
      bundleBytes: 1024,
    });
  });
});

describe("useReviewVersion", () => {
  it("calls review_plugin_version with the decision + notes + report", async () => {
    let seen: Record<string, unknown> | undefined;
    const { client } = mockClient((name, args) => {
      if (name === "review_plugin_version") seen = args;
      return { data: [{ plugin_id: "aero.x", version: "1.0.0", review_status: "approved" }], error: null };
    });
    const { result } = renderHook(() => useReviewVersion(), { wrapper: wrap(client) });
    await act(async () => {
      await result.current.review({
        pluginId: "aero.x",
        version: "1.0.0",
        decision: "approved",
        notes: "lgtm",
        report: { errorCount: 0 },
      });
    });
    expect(seen).toEqual({
      p_plugin_id: "aero.x",
      p_version: "1.0.0",
      p_decision: "approved",
      p_notes: "lgtm",
      p_report: { errorCount: 0 },
    });
  });

  it("surfaces and rethrows an RPC error (e.g. non-reviewer denied)", async () => {
    const { client } = mockClient(() => ({ data: null, error: { message: "insufficient privilege" } }));
    const { result } = renderHook(() => useReviewVersion(), { wrapper: wrap(client) });
    await act(async () => {
      await expect(
        result.current.review({ pluginId: "x", version: "1.0.0", decision: "rejected" }),
      ).rejects.toThrow("insufficient privilege");
    });
  });
});
