import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── mocks ───────────────────────────────────────────────────────────────────
const invoke = vi.fn();
const openDialog = vi.fn();
const readFile = vi.fn();
const upload = vi.fn();
const rpc = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: (...a: unknown[]) => openDialog(...a) }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: (...a: unknown[]) => readFile(...a) }));
vi.mock("@helios/auth", () => ({
  useSupabaseClient: () => ({
    schema: () => ({ rpc: (...a: unknown[]) => rpc(...a) }),
    storage: { from: () => ({ upload: (...a: unknown[]) => upload(...a) }) },
  }),
}));

import { usePublish } from "../usePublish";

const MANIFEST = {
  format: 1,
  id: "aero.test",
  name: "Test",
  version: "1.2.0",
  entry: "dist/index.html",
  sdk: "^1.0.0",
  permissions: [] as string[],
};

const PACKED = {
  stagedPath: "C:/cache/plugins/~publish/abc.hplugin",
  sha256: "a".repeat(64),
  bytes: 4096,
  manifest: MANIFEST,
  entries: ["dist/index.html", "manifest.json"],
  texts: { "dist/index.html": "<!doctype html>", "dist/app.js": "const x=1" },
  warnings: [],
  largest: [["dist/index.html", 100]] as [string, number][],
};

/** Drive the hook from idle to a packed, pre-flighted state. */
async function packed(result: { current: ReturnType<typeof usePublish> }) {
  openDialog.mockResolvedValue("C:/proj/my-plugin");
  await act(async () => {
    await result.current.chooseFolder();
  });
  await waitFor(() => expect(result.current.phase).toBe("preflight"));
}

beforeEach(() => {
  vi.clearAllMocks();
  invoke.mockImplementation((cmd: string) => {
    if (cmd === "pack_plugin_bundle") return Promise.resolve(PACKED);
    return Promise.resolve(undefined);
  });
  rpc.mockImplementation((fn: string) => {
    if (fn === "my_published_plugins") return Promise.resolve({ data: [], error: null });
    if (fn === "publish_plugin_version")
      return Promise.resolve({
        data: [{ plugin_id: "aero.test", version: "1.2.0", review_status: "pending" }],
        error: null,
      });
    return Promise.resolve({ data: [], error: null });
  });
  readFile.mockResolvedValue(new Uint8Array([1, 2, 3]));
  upload.mockResolvedValue({ data: { path: "x" }, error: null });
});

describe("usePublish", () => {
  it("walks idle -> packing -> preflight on a successful pack", async () => {
    const { result } = renderHook(() => usePublish());
    expect(result.current.phase).toBe("idle");

    await packed(result);

    expect(invoke).toHaveBeenCalledWith("pack_plugin_bundle", { dir: "C:/proj/my-plugin" });
    expect(result.current.packed?.sha256).toBe(PACKED.sha256);
    expect(result.current.report?.ok).toBe(true);
    expect(result.current.canSubmit).toBe(true);
  });

  it("stays idle when the folder picker is cancelled", async () => {
    openDialog.mockResolvedValue(null);
    const { result } = renderHook(() => usePublish());

    await act(async () => {
      await result.current.chooseFolder();
    });

    expect(result.current.phase).toBe("idle");
    expect(invoke).not.toHaveBeenCalledWith("pack_plugin_bundle", expect.anything());
  });

  it("surfaces a pack failure in the author's own words", async () => {
    invoke.mockRejectedValueOnce(
      "manifest.entry points at dist/index.html, which is not in this folder — did you run your build?",
    );
    openDialog.mockResolvedValue("C:/proj/my-plugin");
    const { result } = renderHook(() => usePublish());

    await act(async () => {
      await result.current.chooseFolder();
    });

    expect(result.current.phase).toBe("idle");
    expect(result.current.error?.detail).toMatch(/did you run your build\?/);
  });

  it("refuses to advance to confirm while blocking errors are present", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === "pack_plugin_bundle"
        ? Promise.resolve({ ...PACKED, texts: { "dist/app.js": "fetch('/x')" } })
        : Promise.resolve(undefined),
    );
    const { result } = renderHook(() => usePublish());
    await packed(result);

    expect(result.current.report?.ok).toBe(false);
    expect(result.current.canSubmit).toBe(false);

    act(() => result.current.toConfirm());

    expect(result.current.phase).toBe("preflight");
  });

  it("does nothing on submit when pre-flight has not passed", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === "pack_plugin_bundle"
        ? Promise.resolve({ ...PACKED, texts: { "dist/app.js": "eval('1')" } })
        : Promise.resolve(undefined),
    );
    const { result } = renderHook(() => usePublish());
    await packed(result);

    await act(async () => {
      await result.current.submit(null);
    });

    expect(upload).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalledWith("publish_plugin_version", expect.anything());
  });

  it("uploads to the sha256 key with upsert disabled, then publishes", async () => {
    const { result } = renderHook(() => usePublish());
    await packed(result);
    act(() => result.current.toConfirm());

    await act(async () => {
      await result.current.submit("subteam-1");
    });

    expect(readFile).toHaveBeenCalledWith(PACKED.stagedPath);
    expect(upload).toHaveBeenCalledWith(
      PACKED.sha256,
      expect.anything(),
      expect.objectContaining({ upsert: false }),
    );
    expect(rpc).toHaveBeenCalledWith("publish_plugin_version", {
      p_manifest: MANIFEST,
      p_sha256: PACKED.sha256,
      p_bytes: PACKED.bytes,
      p_subteam: "subteam-1",
    });
    expect(result.current.phase).toBe("done");
    expect(result.current.submitted).toEqual({
      pluginId: "aero.test",
      version: "1.2.0",
      reviewStatus: "pending",
    });
  });

  it("treats a duplicate-object upload as success — the key is the content hash", async () => {
    upload.mockResolvedValue({ data: null, error: { message: "The resource already exists" } });
    const { result } = renderHook(() => usePublish());
    await packed(result);
    act(() => result.current.toConfirm());

    await act(async () => {
      await result.current.submit(null);
    });

    expect(result.current.phase).toBe("done");
  });

  it("does not swallow a genuine upload failure", async () => {
    upload.mockResolvedValue({ data: null, error: { message: "Payload too large", statusCode: "413" } });
    const { result } = renderHook(() => usePublish());
    await packed(result);
    act(() => result.current.toConfirm());

    await act(async () => {
      await result.current.submit(null);
    });

    expect(result.current.phase).toBe("confirm");
    expect(result.current.error).toBeTruthy();
    expect(rpc).not.toHaveBeenCalledWith("publish_plugin_version", expect.anything());
  });

  it("keeps the packed bundle after a failure so retry does not re-pack", async () => {
    upload.mockResolvedValueOnce({ data: null, error: { message: "Failed to fetch" } });
    const { result } = renderHook(() => usePublish());
    await packed(result);
    act(() => result.current.toConfirm());

    await act(async () => {
      await result.current.submit(null);
    });

    expect(result.current.error?.retryable).toBe(true);
    expect(result.current.packed?.sha256).toBe(PACKED.sha256);

    // Retry: no second pack, and it goes through.
    upload.mockResolvedValue({ data: { path: "x" }, error: null });
    await act(async () => {
      await result.current.submit(null);
    });

    expect(invoke).toHaveBeenCalledTimes(
      invoke.mock.calls.filter((c) => c[0] === "pack_plugin_bundle").length +
        invoke.mock.calls.filter((c) => c[0] !== "pack_plugin_bundle").length,
    );
    expect(invoke.mock.calls.filter((c) => c[0] === "pack_plugin_bundle")).toHaveLength(1);
    expect(result.current.phase).toBe("done");
  });

  it("maps a publish rejection through explainPublishError", async () => {
    rpc.mockImplementation((fn: string) => {
      if (fn === "my_published_plugins") return Promise.resolve({ data: [], error: null });
      if (fn === "publish_plugin_version")
        return Promise.resolve({
          data: null,
          error: { message: "version 1.2.0 of aero.test already exists (versions are immutable)" },
        });
      return Promise.resolve({ data: [], error: null });
    });
    const { result } = renderHook(() => usePublish());
    await packed(result);
    act(() => result.current.toConfirm());

    await act(async () => {
      await result.current.submit(null);
    });

    expect(result.current.error?.title).toMatch(/1\.2\.0 has already been published/);
    expect(result.current.error?.detail).toMatch(/1\.2\.1/);
  });

  it("locks the subteam of an existing plugin instead of taking the caller's word", async () => {
    rpc.mockImplementation((fn: string) => {
      if (fn === "my_published_plugins")
        return Promise.resolve({
          data: [
            {
              plugin_id: "aero.test",
              subteam: "owning-subteam",
              version: "1.1.0",
              permissions: ["storage"],
              review_status: "approved",
              published_at: "2026-08-01T00:00:00Z",
            },
          ],
          error: null,
        });
      if (fn === "publish_plugin_version")
        return Promise.resolve({
          data: [{ plugin_id: "aero.test", version: "1.2.0", review_status: "pending" }],
          error: null,
        });
      return Promise.resolve({ data: [], error: null });
    });
    const { result } = renderHook(() => usePublish());
    await packed(result);

    expect(result.current.isNewPlugin).toBe(false);
    expect(result.current.lockedSubteam).toBe("owning-subteam");

    act(() => result.current.toConfirm());
    await act(async () => {
      await result.current.submit("some-other-subteam");
    });

    // The caller's choice is ignored — ownership cannot be reassigned.
    expect(rpc).toHaveBeenCalledWith(
      "publish_plugin_version",
      expect.objectContaining({ p_subteam: "owning-subteam" }),
    );
  });

  it("diffs permissions against the last approved version", async () => {
    rpc.mockImplementation((fn: string) => {
      if (fn === "my_published_plugins")
        return Promise.resolve({
          data: [
            {
              plugin_id: "aero.test",
              subteam: "s1",
              version: "1.1.0",
              permissions: ["storage"],
              review_status: "approved",
              published_at: "2026-08-01T00:00:00Z",
            },
          ],
          error: null,
        });
      return Promise.resolve({ data: [], error: null });
    });
    invoke.mockImplementation((cmd: string) =>
      cmd === "pack_plugin_bundle"
        ? Promise.resolve({
            ...PACKED,
            manifest: { ...MANIFEST, permissions: ["storage", "engine:matlab"] },
            texts: { "dist/app.js": "storage.set('k',1); engine.matlab.run('x')" },
          })
        : Promise.resolve(undefined),
    );
    const { result } = renderHook(() => usePublish());
    await packed(result);

    expect(result.current.diff?.added).toEqual(["engine:matlab"]);
    expect(result.current.diff?.addsHighTrust).toBe(true);
  });

  it("discards the staged bundle once the version has landed", async () => {
    const { result } = renderHook(() => usePublish());
    await packed(result);
    act(() => result.current.toConfirm());

    await act(async () => {
      await result.current.submit(null);
    });

    expect(invoke).toHaveBeenCalledWith("discard_staged_bundle", { sha256: PACKED.sha256 });
  });

  it("re-checks the same folder without a second trip through the picker", async () => {
    const { result } = renderHook(() => usePublish());
    await packed(result);
    openDialog.mockClear();

    await act(async () => {
      await result.current.recheck();
    });

    expect(openDialog).not.toHaveBeenCalled();
    expect(invoke.mock.calls.filter((c) => c[0] === "pack_plugin_bundle")).toHaveLength(2);
  });

  it("reset returns the flow to idle", async () => {
    const { result } = renderHook(() => usePublish());
    await packed(result);

    act(() => result.current.reset());

    expect(result.current.phase).toBe("idle");
    expect(result.current.packed).toBeNull();
  });
});
