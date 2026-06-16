import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSubmitReport } from "../useSubmitReport";
import type { ReportDraft, ReportDiagnostics } from "../types";

// useHeliosAuth is mocked so the hook runs without a real provider. The two
// identity helpers mirror the real AuthShell implementations (read from
// user_metadata, fall back to the email local part).
const h = vi.hoisted(() => ({ auth: { client: null as any, user: null as any } }));
vi.mock("../../../auth/AuthShell", () => ({
  useHeliosAuth: () => h.auth,
  userDisplayName: (u: any) => {
    const dn = u?.user_metadata?.display_name;
    if (typeof dn === "string" && dn.trim()) return dn.trim();
    if (u?.email) { const at = u.email.indexOf("@"); return at > 0 ? u.email.slice(0, at) : u.email; }
    return "user";
  },
  userSubteam: (u: any) => {
    const s = u?.user_metadata?.subteam;
    return typeof s === "string" && s.trim() ? s.trim() : null;
  },
}));

const draft: ReportDraft = { kind: "bug", severity: "annoying", title: "  Title  ", what_doing: " did x ", details: "" };
const diag: ReportDiagnostics = {
  module: "vault", app_version: "4.3.7", os: "win32",
  breadcrumbs: [{ t: "now", category: "nav", message: "module -> vault" }],
  last_error: null,
};

function makeClient(opts: { uploadErr?: string; insertErr?: string } = {}) {
  const calls: string[] = [];
  const captured: { inserted: any } = { inserted: null };
  const client = {
    storage: {
      from: (_bucket: string) => ({
        upload: async (_key: string, _blob: Blob, _o: unknown) => {
          calls.push("upload");
          return { error: opts.uploadErr ? { message: opts.uploadErr } : null };
        },
      }),
    },
    schema: (s: string) => ({
      from: (_t: string) => ({
        insert: async (row: any) => {
          calls.push(`insert:${s}`);
          captured.inserted = row;
          return { error: opts.insertErr ? { message: opts.insertErr } : null };
        },
      }),
    }),
  };
  return { client, calls, captured };
}

describe("useSubmitReport", () => {
  beforeEach(() => {
    h.auth = { client: null, user: { id: "u1" } };
  });

  it("uploads the screenshot BEFORE inserting, with screenshot_path set", async () => {
    const { client, calls, captured } = makeClient();
    h.auth.client = client;
    const { result } = renderHook(() => useSubmitReport());
    let ok = false;
    await act(async () => { ok = await result.current.submit(draft, diag, new Blob(["x"])); });
    expect(ok).toBe(true);
    expect(calls).toEqual(["upload", "insert:support"]);
    expect(captured.inserted.screenshot_path).toMatch(/\.png$/);
  });

  it("skips upload and leaves screenshot_path null when no screenshot", async () => {
    const { client, calls, captured } = makeClient();
    h.auth.client = client;
    const { result } = renderHook(() => useSubmitReport());
    await act(async () => { await result.current.submit(draft, diag, null); });
    expect(calls).toEqual(["insert:support"]);
    expect(captured.inserted.screenshot_path).toBeNull();
  });

  it("sends the expected payload (trimmed, with diagnostics)", async () => {
    const { client, captured } = makeClient();
    h.auth.client = client;
    const { result } = renderHook(() => useSubmitReport());
    await act(async () => { await result.current.submit(draft, diag, null); });
    expect(captured.inserted).toMatchObject({
      kind: "bug", severity: "annoying", title: "Title", what_doing: "did x", details: null,
      module: "vault", app_version: "4.3.7", os: "win32",
    });
    expect(captured.inserted.breadcrumbs).toHaveLength(1);
  });

  it("denormalizes the reporter's name/subteam/email from the signed-in user", async () => {
    const { client, captured } = makeClient();
    h.auth = {
      client,
      user: { id: "u1", email: "nick@asu.edu", user_metadata: { display_name: "Nick Murray", subteam: "Aero" } },
    };
    const { result } = renderHook(() => useSubmitReport());
    await act(async () => { await result.current.submit(draft, diag, null); });
    expect(captured.inserted).toMatchObject({
      reporter_name: "Nick Murray", reporter_subteam: "Aero", reporter_email: "nick@asu.edu",
    });
  });

  it("uses an extension matching the uploaded image's MIME type", async () => {
    const { client, captured } = makeClient();
    h.auth.client = client;
    const { result } = renderHook(() => useSubmitReport());
    await act(async () => { await result.current.submit(draft, diag, new Blob(["x"], { type: "image/jpeg" })); });
    expect(captured.inserted.screenshot_path).toMatch(/\.jpg$/);
  });

  it("surfaces an insert error and returns false (no throw)", async () => {
    const { client } = makeClient({ insertErr: "boom" });
    h.auth.client = client;
    const { result } = renderHook(() => useSubmitReport());
    let ok = true;
    await act(async () => { ok = await result.current.submit(draft, diag, null); });
    expect(ok).toBe(false);
    expect(result.current.error).toBe("boom");
  });

  it("does not insert if the screenshot upload fails", async () => {
    const { client, calls } = makeClient({ uploadErr: "no space" });
    h.auth.client = client;
    const { result } = renderHook(() => useSubmitReport());
    let ok = true;
    await act(async () => { ok = await result.current.submit(draft, diag, new Blob(["x"])); });
    expect(ok).toBe(false);
    expect(calls).toEqual(["upload"]);
    expect(result.current.error).toMatch(/upload failed/i);
  });
});
