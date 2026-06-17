import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useReports } from "../useReports";
import type { ReportRow } from "../types";

const h = vi.hoisted(() => ({ auth: { client: null as any } }));
vi.mock("../../../auth/AuthShell", () => ({ useHeliosAuth: () => h.auth }));

const rows: ReportRow[] = [
  { id: "r1", created_at: "2026-06-15T10:00:00Z", reporter_id: "u1", kind: "bug", severity: "annoying",
    title: "A", what_doing: "", details: "", reporter_name: "Nick Murray", reporter_subteam: "Aero",
    reporter_email: "nick@asu.edu", module: "vault", app_version: "4.3.7", os: "win32",
    breadcrumbs: [], last_error: null, screenshot_path: null, status: "new", admin_note: null },
];

function makeClient() {
  const calls: string[] = [];
  const client = {
    storage: {
      from: (_b: string) => ({
        remove: async (paths: string[]) => {
          calls.push(`storage.remove:${paths.join(",")}`);
          return { error: null };
        },
      }),
    },
    schema: (s: string) => ({
      from: (_t: string) => ({
        select: (_c: string) => ({
          order: async (_col: string, _o: unknown) => {
            calls.push(`select:${s}`);
            return { data: rows, error: null };
          },
        }),
        update: (patch: { status: string }) => ({
          eq: async (_col: string, id: string) => {
            calls.push(`update:${s}:${id}:${patch.status}`);
            return { error: null };
          },
        }),
        delete: () => ({
          eq: async (_col: string, id: string) => {
            calls.push(`delete:${s}:${id}`);
            return { error: null };
          },
        }),
      }),
    }),
  };
  return { client, calls };
}

describe("useReports", () => {
  beforeEach(() => {
    h.auth = { client: null };
  });

  it("loads reports newest-first from the support schema on mount", async () => {
    const { client, calls } = makeClient();
    h.auth.client = client;
    const { result } = renderHook(() => useReports());
    await waitFor(() => expect(result.current.reports).toHaveLength(1));
    expect(result.current.reports[0]!.id).toBe("r1");
    expect(calls).toContain("select:support");
  });

  it("setStatus updates via the support schema and patches local state", async () => {
    const { client, calls } = makeClient();
    h.auth.client = client;
    const { result } = renderHook(() => useReports());
    await waitFor(() => expect(result.current.reports).toHaveLength(1));
    let ok = false;
    await act(async () => { ok = await result.current.setStatus("r1", "fixed"); });
    expect(ok).toBe(true);
    expect(calls).toContain("update:support:r1:fixed");
    expect(result.current.reports[0]!.status).toBe("fixed");
  });

  it("remove deletes the screenshot then the row and drops it from local state", async () => {
    const { client, calls } = makeClient();
    h.auth.client = client;
    const { result } = renderHook(() => useReports());
    await waitFor(() => expect(result.current.reports).toHaveLength(1));
    let ok = false;
    await act(async () => { ok = await result.current.remove("r1", "shot.png"); });
    expect(ok).toBe(true);
    expect(calls).toContain("storage.remove:shot.png");
    expect(calls).toContain("delete:support:r1");
    expect(result.current.reports).toHaveLength(0);
  });

  it("remove skips the storage call when there is no screenshot", async () => {
    const { client, calls } = makeClient();
    h.auth.client = client;
    const { result } = renderHook(() => useReports());
    await waitFor(() => expect(result.current.reports).toHaveLength(1));
    await act(async () => { await result.current.remove("r1", null); });
    expect(calls.some((c) => c.startsWith("storage.remove"))).toBe(false);
    expect(calls).toContain("delete:support:r1");
  });
});
