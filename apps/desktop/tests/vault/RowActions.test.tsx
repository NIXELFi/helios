import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SupabaseAuthProvider, useUser } from "@helios/auth";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CheckInButton, CheckOutButton, CancelButton } from "../../src/modules/vault/components/RowActions";

// Capture the real-vault read-only transitions + download-on-checkout/undo.
const roCalls = vi.hoisted(() => [] as Array<{ path: string; readonly: boolean }>);
vi.mock("../../src/modules/vault/data/fs-readonly", () => ({
  setReadonly: (path: string, readonly: boolean) => { roCalls.push({ path, readonly }); return Promise.resolve(); },
  flipSwReadonly: vi.fn(),
}));
// CheckInButton now records assembly refs after a successful check-in (it
// parses the file via the parse_sw_refs Tauri command). There's no Tauri
// runtime in jsdom, so reject — useRecordRefs swallows it, keeping these tests
// focused on the check-in/lock behavior they assert.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockRejectedValue(new Error("no tauri in test")) }));
// Base version for the check-in stale guard: what the ledger says this machine
// last materialized at the file's path.
const ledgerSha = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock("../../src/modules/vault/data/sync-ledger", () => ({
  ledgerRecord: vi.fn().mockResolvedValue(undefined),
  ledgerShaFor: vi.fn(async () => ledgerSha.value),
}));
const dlCalls = vi.hoisted(() => [] as Array<{ sha: string; dest: string }>);
const dlResult = vi.hoisted(() => ({ ok: true }));
vi.mock("../../src/modules/vault/data/useDownloadVersion", () => ({
  useDownloadVersion: () => ({
    run: (sha: string, dest: string) => { dlCalls.push({ sha, dest }); return Promise.resolve(dlResult.ok); },
    loading: false, error: null,
    // Real hook mirrors the failure here synchronously; `error` state is stale
    // inside the awaiting closure, so callers must read the ref.
    errorRef: { current: dlResult.ok ? null : new Error("disk full") },
  }),
}));

/** Renders the resolved user id so a test can wait for the session before
 *  clicking Check Out (useAcquireLock needs the user). */
function UserProbe() {
  const u = useUser();
  return <span data-testid="uid">{u?.id ?? ""}</span>;
}

// Mock Tauri plugins so tests don't need a real Tauri runtime. readFile is the
// source of the bytes that get checked in; the dialog open() picks the file
// when there's no localFile prop.
const readFileMock = vi.fn(async () => new Uint8Array([1, 2, 3, 4]));
// stat() feeds the saved-again mtime guard; default = a constant mtime.
const statMock = vi.fn(async (_p: string) => ({ mtime: new Date(1000) }));
vi.mock("@tauri-apps/plugin-fs", () => ({
  readFile: (...args: unknown[]) => readFileMock(...(args as [])),
  stat: (p: string) => statMock(p),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue("/tmp/fake.sldprt"),
  save: vi.fn().mockResolvedValue("/tmp/picked-save.sldprt"),
}));

const VERSION_ROW = {
  id: "v1",
  file_id: "f1",
  version_num: 1,
  sha256: "abc",
  size_bytes: 4,
  author_id: "u1",
  comment: "typed comment",
  parent_version_id: null,
  created_at: "2026-01-01",
};

let capturedRpc: { name: string; args: any } | null = null;

/** Client wired for useCheckIn / useReleaseLock (rpc) and useAcquireLock
 *  (locks insert). `rpcError` lets a test force the check-in/release path to
 *  fail so we can assert error surfacing. */
function mockClient(opts: { rpcError?: any; insertError?: any } = {}): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: "u1" } } },
        error: null,
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    storage: {
      from: () => ({
        list: () => Promise.resolve({ data: [], error: null }),
        upload: () => Promise.resolve({ data: null, error: null }),
      }),
    },
    from: (table: string) => {
      if (table === "locks") {
        return {
          insert: () => ({
            select: () => ({
              single: () =>
                Promise.resolve({
                  data: opts.insertError
                    ? null
                    : { id: "l1", file_id: "f1", user_id: "u1", acquired_at: "x", released_at: null, force_released_by: null },
                  error: opts.insertError ?? null,
                }),
            }),
          }),
        };
      }
      return { select: () => Promise.resolve({ data: [], error: null }) };
    },
    rpc: (name: string, args: any) => {
      capturedRpc = { name, args };
      return Promise.resolve({ data: opts.rpcError ? null : VERSION_ROW, error: opts.rpcError ?? null });
    },
  } as any;
}

const localFile = {
  basename: "frame.sldprt",
  relativePath: "frame.sldprt",
  absolutePath: "/x/frame.sldprt",
  sha256: "abc",
  sizeBytes: 4,
};

function wrap(client: SupabaseClient, children: React.ReactNode) {
  return <SupabaseAuthProvider client={client}>{children}</SupabaseAuthProvider>;
}

describe("RowActions real-vault read-only transitions", () => {
  beforeEach(() => { capturedRpc = null; roCalls.length = 0; dlCalls.length = 0; dlResult.ok = true; });

  it("check-out downloads the file if missing, then makes it writable", async () => {
    render(wrap(mockClient(), <><CheckOutButton fileId={"f1" as any} vaultRoot="/v" folderId={null} fileName="a.bin" folders={[]} latestSha="sha-x" /><UserProbe /></>));
    await waitFor(() => expect(screen.getByTestId("uid")).toHaveTextContent("u1"));
    fireEvent.click(screen.getByRole("button", { name: /check out/i }));
    await waitFor(() => expect(dlCalls).toContainEqual({ sha: "sha-x", dest: "/v/a.bin" }));
    expect(roCalls).toContainEqual({ path: "/v/a.bin", readonly: false });
  });

  it("check-out rolls back (releases the lock, stays read-only) when the latest download fails", async () => {
    // 2026-06-09 audit HIGH: a failed download used to fall through to
    // setReadonly(dest, false), leaving a STALE local copy writable under a
    // fresh lock — an invitation to edit an outdated base and check it in
    // over a teammate's newer version.
    dlResult.ok = false;
    render(wrap(mockClient(), <><CheckOutButton fileId={"f1" as any} vaultRoot="/v" folderId={null} fileName="a.bin" folders={[]} latestSha="sha-x" /><UserProbe /></>));
    await waitFor(() => expect(screen.getByTestId("uid")).toHaveTextContent("u1"));
    fireEvent.click(screen.getByRole("button", { name: /check out/i }));
    await waitFor(() => expect(dlCalls).toContainEqual({ sha: "sha-x", dest: "/v/a.bin" }));
    // The lock is rolled back via pdm_cancel_checkout…
    await waitFor(() => expect(capturedRpc?.name).toBe("pdm_cancel_checkout"));
    expect(capturedRpc?.args?.p_file_id).toBe("f1");
    // …the file is never made writable…
    expect(roCalls).toHaveLength(0);
    // …and the button surfaces what happened.
    const btn = screen.getByRole("button", { name: /retry/i });
    expect(btn).toHaveAttribute("title", expect.stringContaining("rolled back"));
  });

  it("check-out of an already-local file makes it writable without re-downloading", async () => {
    const local = { basename: "a.bin", relativePath: "a.bin", absolutePath: "/v/a.bin", sha256: "sha-x", sizeBytes: 4, readonly: true };
    render(wrap(mockClient(), <><CheckOutButton fileId={"f1" as any} vaultRoot="/v" folderId={null} fileName="a.bin" folders={[]} latestSha="sha-x" localFile={local as any} /><UserProbe /></>));
    await waitFor(() => expect(screen.getByTestId("uid")).toHaveTextContent("u1"));
    fireEvent.click(screen.getByRole("button", { name: /check out/i }));
    await waitFor(() => expect(roCalls).toContainEqual({ path: "/v/a.bin", readonly: false }));
    expect(dlCalls).toHaveLength(0);
  });

  describe("check-out over a writable local copy that differs from the vault", () => {
    const dirty = { basename: "a.bin", relativePath: "a.bin", absolutePath: "/v/a.bin", sha256: "mine", sizeBytes: 4, readonly: false };
    const renderDirty = (local: any = dirty) =>
      render(wrap(mockClient(), <><CheckOutButton fileId={"f1" as any} vaultRoot="/v" folderId={null} fileName="a.bin" folders={[]} latestSha="sha-x" localFile={local} /><UserProbe /></>));

    it("asks before touching it, and Cancel changes nothing", async () => {
      renderDirty();
      await waitFor(() => expect(screen.getByTestId("uid")).toHaveTextContent("u1"));
      fireEvent.click(screen.getByRole("button", { name: /check out/i }));
      expect(await screen.findByRole("button", { name: /keep my copy/i })).toBeInTheDocument();
      expect(dlCalls).toHaveLength(0);
      expect(capturedRpc).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
      await waitFor(() => expect(screen.queryByRole("button", { name: /keep my copy/i })).not.toBeInTheDocument());
      expect(dlCalls).toHaveLength(0);
      expect(roCalls).toHaveLength(0);
      // The in-flight guard is released so the user can try again.
      expect(screen.getByRole("button", { name: /check out/i })).toBeEnabled();
    });

    it("Keep my copy takes the lock without downloading and leaves it writable", async () => {
      renderDirty();
      await waitFor(() => expect(screen.getByTestId("uid")).toHaveTextContent("u1"));
      fireEvent.click(screen.getByRole("button", { name: /check out/i }));
      fireEvent.click(await screen.findByRole("button", { name: /keep my copy/i }));
      await waitFor(() => expect(roCalls).toContainEqual({ path: "/v/a.bin", readonly: false }));
      expect(dlCalls).toHaveLength(0);
    });

    it("Replace with latest downloads over it (the previous behavior)", async () => {
      renderDirty();
      await waitFor(() => expect(screen.getByTestId("uid")).toHaveTextContent("u1"));
      fireEvent.click(screen.getByRole("button", { name: /check out/i }));
      fireEvent.click(await screen.findByRole("button", { name: /replace with latest/i }));
      await waitFor(() => expect(dlCalls).toContainEqual({ sha: "sha-x", dest: "/v/a.bin" }));
      expect(roCalls).toContainEqual({ path: "/v/a.bin", readonly: false });
    });

    it("does not ask for a read-only stale copy (just refreshed) or a writable copy equal to latest", async () => {
      renderDirty({ ...dirty, readonly: true });
      await waitFor(() => expect(screen.getByTestId("uid")).toHaveTextContent("u1"));
      fireEvent.click(screen.getByRole("button", { name: /check out/i }));
      await waitFor(() => expect(dlCalls).toContainEqual({ sha: "sha-x", dest: "/v/a.bin" }));
      expect(screen.queryByRole("button", { name: /keep my copy/i })).not.toBeInTheDocument();
    });

    it("does not ask when the writable copy already matches the latest version", async () => {
      renderDirty({ ...dirty, sha256: "SHA-X" });
      await waitFor(() => expect(screen.getByTestId("uid")).toHaveTextContent("u1"));
      fireEvent.click(screen.getByRole("button", { name: /check out/i }));
      await waitFor(() => expect(roCalls).toContainEqual({ path: "/v/a.bin", readonly: false }));
      expect(screen.queryByRole("button", { name: /keep my copy/i })).not.toBeInTheDocument();
      expect(dlCalls).toHaveLength(0);
    });
  });

  describe("check-in base-version guard", () => {
    const local = { basename: "a.bin", relativePath: "a.bin", absolutePath: "/v/a.bin", sha256: "edited", sizeBytes: 4, readonly: false };
    const STALE = "A newer version (v3) was checked in after your copy was made, so checking it in would replace that work. Get the latest, redo your change, then check in.";

    it("sends the ledger base, and on a stale refusal offers Check in anyway without it", async () => {
      ledgerSha.value = "base-sha";
      const calls: any[] = [];
      const base = mockClient();
      const client = {
        ...base,
        rpc: (name: string, args: any) => {
          if (name !== "pdm_check_in") return base.rpc(name, args);
          calls.push(args);
          return Promise.resolve(calls.length === 1
            ? { data: null, error: { code: "P0001", message: STALE } }
            : { data: VERSION_ROW, error: null });
        },
      } as any;
      render(wrap(client, <CheckInButton fileId={"f1" as any} localFile={local as any} vaultRoot="/v" folderId={null} fileName="a.bin" folders={[]} vaultId="vault-1" />));
      fireEvent.click(screen.getByRole("button", { name: /check in/i }));
      fireEvent.click(await screen.findByRole("button", { name: /submit/i }));
      expect(await screen.findByText(/a newer version is in the vault/i)).toBeInTheDocument();
      expect(calls[0].p_base_sha256).toBe("base-sha");
      fireEvent.click(screen.getByRole("button", { name: /check in anyway/i }));
      await waitFor(() => expect(calls.length).toBe(2));
      expect(calls[1].p_base_sha256).toBeUndefined();
      ledgerSha.value = undefined;
    });

    it("sends no base when the ledger has none", async () => {
      ledgerSha.value = undefined;
      render(wrap(mockClient(), <CheckInButton fileId={"f1" as any} localFile={local as any} vaultRoot="/v" folderId={null} fileName="a.bin" folders={[]} vaultId="vault-1" />));
      fireEvent.click(screen.getByRole("button", { name: /check in/i }));
      fireEvent.click(await screen.findByRole("button", { name: /submit/i }));
      await waitFor(() => expect(capturedRpc?.name).toBe("pdm_check_in"));
      expect(capturedRpc!.args.p_base_sha256).toBeUndefined();
    });
  });

  describe("check-in saved-again guard", () => {
    const local = { basename: "a.bin", relativePath: "a.bin", absolutePath: "/v/a.bin", sha256: "old", sizeBytes: 4, readonly: false };

    it("leaves the copy writable when it was saved again while the modal was open", async () => {
      statMock.mockReset();
      statMock.mockResolvedValueOnce({ mtime: new Date(1000) }).mockResolvedValue({ mtime: new Date(2000) });
      render(wrap(mockClient(), <CheckInButton fileId={"f1" as any} localFile={local as any} vaultRoot="/v" folderId={null} fileName="a.bin" folders={[]} />));
      fireEvent.click(screen.getByRole("button", { name: /check in/i }));
      fireEvent.click(await screen.findByRole("button", { name: /submit/i }));
      await waitFor(() => expect(capturedRpc?.name).toBe("pdm_check_in"));
      await waitFor(() => expect(statMock).toHaveBeenCalledTimes(2));
      await new Promise((r) => setTimeout(r, 20));
      expect(roCalls).not.toContainEqual({ path: "/v/a.bin", readonly: true });
      statMock.mockReset();
      statMock.mockImplementation(async () => ({ mtime: new Date(1000) }));
    });

    it("freezes it when the mtime is unchanged", async () => {
      statMock.mockImplementation(async () => ({ mtime: new Date(1000) }));
      render(wrap(mockClient(), <CheckInButton fileId={"f1" as any} localFile={local as any} vaultRoot="/v" folderId={null} fileName="a.bin" folders={[]} />));
      fireEvent.click(screen.getByRole("button", { name: /check in/i }));
      fireEvent.click(await screen.findByRole("button", { name: /submit/i }));
      await waitFor(() => expect(roCalls).toContainEqual({ path: "/v/a.bin", readonly: true }));
    });

    it("stands down (still freezes) when stat fails", async () => {
      statMock.mockReset();
      statMock.mockRejectedValue(new Error("no stat"));
      render(wrap(mockClient(), <CheckInButton fileId={"f1" as any} localFile={local as any} vaultRoot="/v" folderId={null} fileName="a.bin" folders={[]} />));
      fireEvent.click(screen.getByRole("button", { name: /check in/i }));
      fireEvent.click(await screen.findByRole("button", { name: /submit/i }));
      await waitFor(() => expect(roCalls).toContainEqual({ path: "/v/a.bin", readonly: true }));
      statMock.mockReset();
      statMock.mockImplementation(async () => ({ mtime: new Date(1000) }));
    });
  });

  it("undo check-out skips the re-download when the local copy already is the latest", async () => {
    const same = { basename: "a.bin", relativePath: "a.bin", absolutePath: "/v/a.bin", sha256: "sha-x", sizeBytes: 4, readonly: false };
    render(wrap(mockClient(), <CancelButton fileId={"f1" as any} vaultRoot="/v" folderId={null} fileName="a.bin" folders={[]} latestSha="sha-x" latestVersionId="v1" localFile={same as any} />));
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /discard & undo/i }));
    await waitFor(() => expect(roCalls).toContainEqual({ path: "/v/a.bin", readonly: true }));
    expect(dlCalls).toHaveLength(0);
  });

  it("undo check-out still restores when the local copy differs", async () => {
    const edited = { basename: "a.bin", relativePath: "a.bin", absolutePath: "/v/a.bin", sha256: "mine", sizeBytes: 4, readonly: false };
    render(wrap(mockClient(), <CancelButton fileId={"f1" as any} vaultRoot="/v" folderId={null} fileName="a.bin" folders={[]} latestSha="sha-x" latestVersionId="v1" localFile={edited as any} />));
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /discard & undo/i }));
    await waitFor(() => expect(dlCalls).toContainEqual({ sha: "sha-x", dest: "/v/a.bin" }));
  });

  it("undo check-out surfaces the download failure reason (read from the ref, not stale state) and keeps the edit writable", async () => {
    dlResult.ok = false;
    render(wrap(mockClient(), <CancelButton fileId={"f1" as any} vaultRoot="/v" folderId={null} fileName="a.bin" folders={[]} latestSha="sha-x" latestVersionId="v1" />));
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /discard & undo/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /retry/i }).getAttribute("title")).toMatch(/disk full/));
    expect(roCalls).toHaveLength(0);
  });

  it("undo check-out keys 'draft' on latest_version_id, not the embedded latest sha", async () => {
    // Published file (has a latest_version_id) whose embedded latest row is
    // briefly null: must NOT offer the draft discard (it soft-deletes the file).
    const { unmount } = render(wrap(mockClient(), <CancelButton fileId={"f1" as any} latestSha={null} latestVersionId="v1" />));
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(await screen.findByRole("button", { name: /discard & undo/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /discard draft/i })).toBeNull();
    unmount();
    // A genuine draft (no latest_version_id) still offers the discard.
    render(wrap(mockClient(), <CancelButton fileId={"f1" as any} latestSha="sha-x" latestVersionId={null} />));
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(await screen.findByRole("button", { name: /discard draft/i })).toBeTruthy();
  });

  it("check-in makes the file read-only after a successful check-in", async () => {
    const local = { basename: "a.bin", relativePath: "a.bin", absolutePath: "/v/a.bin", sha256: "old", sizeBytes: 4, readonly: false };
    render(wrap(mockClient(), <CheckInButton fileId={"f1" as any} localFile={local as any} vaultRoot="/v" folderId={null} fileName="a.bin" folders={[]} />));
    fireEvent.click(screen.getByRole("button", { name: /check in/i }));
    fireEvent.click(await screen.findByRole("button", { name: /submit/i }));
    await waitFor(() => expect(roCalls).toContainEqual({ path: "/v/a.bin", readonly: true }));
  });

  it("undo does NOT release the lock until the confirm is accepted", async () => {
    render(wrap(mockClient(), <CancelButton fileId={"f1" as any} vaultRoot="/v" folderId={null} fileName="a.bin" folders={[]} latestSha="sha-x" />));
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    // The confirm is shown, but nothing destructive has happened yet.
    expect(await screen.findByRole("button", { name: /discard & undo/i })).toBeInTheDocument();
    expect(capturedRpc).toBeNull(); // pdm_cancel_checkout NOT called
    expect(dlCalls).toHaveLength(0); // no restore download
    expect(roCalls).toHaveLength(0);
  });

  it("undo check-out restores the latest version and sets read-only", async () => {
    render(wrap(mockClient(), <CancelButton fileId={"f1" as any} vaultRoot="/v" folderId={null} fileName="a.bin" folders={[]} latestSha="sha-x" />));
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /discard & undo/i }));
    await waitFor(() => expect(dlCalls).toContainEqual({ sha: "sha-x", dest: "/v/a.bin" }));
    expect(roCalls).toContainEqual({ path: "/v/a.bin", readonly: true });
  });
});

describe("CheckInButton (C1: in-app comment modal, not window.prompt)", () => {
  beforeEach(() => {
    capturedRpc = null;
    readFileMock.mockClear();
  });

  it("never calls window.prompt", async () => {
    const promptSpy = vi.spyOn(window, "prompt");
    render(wrap(mockClient(), <CheckInButton fileId={"f1" as any} localFile={localFile as any} />));
    fireEvent.click(screen.getByRole("button", { name: /check in/i }));
    // After reading the bytes a modal should open; window.prompt must not run.
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    expect(promptSpy).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });

  it("opens a comment modal when clicked", async () => {
    render(wrap(mockClient(), <CheckInButton fileId={"f1" as any} localFile={localFile as any} />));
    fireEvent.click(screen.getByRole("button", { name: /check in/i }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    // The modal has a comment textarea and a Submit affordance.
    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /submit/i })).toBeInTheDocument();
  });

  it("submitting the modal runs check-in with the typed comment", async () => {
    render(wrap(mockClient(), <CheckInButton fileId={"f1" as any} localFile={localFile as any} />));
    fireEvent.click(screen.getByRole("button", { name: /check in/i }));
    await screen.findByRole("dialog");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "my message" } });
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));
    await waitFor(() => expect(capturedRpc?.name).toBe("pdm_check_in"));
    expect(capturedRpc?.args?.p_comment).toBe("my message");
    expect(capturedRpc?.args?.p_file_id).toBe("f1");
  });

  it("reads the local bytes before opening the modal", async () => {
    render(wrap(mockClient(), <CheckInButton fileId={"f1" as any} localFile={localFile as any} />));
    fireEvent.click(screen.getByRole("button", { name: /check in/i }));
    await screen.findByRole("dialog");
    expect(readFileMock).toHaveBeenCalledWith("/x/frame.sldprt");
  });

  it("Cancel closes the modal without running check-in", async () => {
    render(wrap(mockClient(), <CheckInButton fileId={"f1" as any} localFile={localFile as any} />));
    fireEvent.click(screen.getByRole("button", { name: /check in/i }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(capturedRpc).toBeNull();
  });

  it("Skip submits check-in with a null comment", async () => {
    render(wrap(mockClient(), <CheckInButton fileId={"f1" as any} localFile={localFile as any} />));
    fireEvent.click(screen.getByRole("button", { name: /check in/i }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: /skip/i }));
    await waitFor(() => expect(capturedRpc?.name).toBe("pdm_check_in"));
    expect(capturedRpc?.args?.p_comment).toBeNull();
  });
});

describe("RowActions error surfacing (H2)", () => {
  it("CheckInButton surfaces a check-in failure via title + retry label", async () => {
    render(wrap(mockClient({ rpcError: { message: "lock required" } }), <CheckInButton fileId={"f1" as any} localFile={localFile as any} />));
    fireEvent.click(screen.getByRole("button", { name: /check in/i }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: /submit/i }));
    // After the failure the trigger button reflects the error state.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /retry|check in/i }).getAttribute("title")).toMatch(/lock required/i),
    );
  });

  it("CheckOutButton surfaces an acquire-lock failure via title", async () => {
    render(wrap(mockClient({ insertError: { message: "already checked out", code: "23505" } }), <CheckOutButton fileId={"f1" as any} />));
    // Wait for the auth user to settle so run() hits the insert path (rather
    // than the no-user short-circuit) before we click.
    await waitFor(() => expect(screen.getByRole("button", { name: /check out/i })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /check out/i }));
    await waitFor(() => {
      const btn = screen.getByRole("button", { name: /check out|retry/i });
      // Either the insert error ("already checked out") or, if auth hadn't
      // hydrated, the session-expired guard — both are surfaced as a failure
      // title rather than silently swallowed.
      expect(btn.getAttribute("title")).toMatch(/failed:/i);
    });
  });

  it("CancelButton confirms before undoing, then surfaces a release-lock failure via title", async () => {
    // latestSha present → a checked-in file → the undo-checkout flow.
    render(wrap(mockClient({ rpcError: { message: "no active lock" } }), <CancelButton fileId={"f1" as any} latestSha="sha-x" />));
    // Click Cancel → opens the undo-checkout confirm (does NOT release yet).
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    // Confirm the destructive undo → now the release runs and fails.
    fireEvent.click(await screen.findByRole("button", { name: /discard & undo/i }));
    await waitFor(() => {
      const btn = screen.getByRole("button", { name: /cancel|retry/i });
      expect(btn.getAttribute("title")).toMatch(/no active lock|lock/i);
    });
  });

  it("CancelButton on a never-checked-in draft offers Discard draft instead of undo", async () => {
    // No latestSha → draft: there is no version to restore, so undo-checkout
    // becomes a confirmed discard (soft-delete; lock released server-side).
    render(wrap(mockClient(), <CancelButton fileId={"f1" as any} />));
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(await screen.findByRole("button", { name: /discard draft/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /discard & undo/i })).toBeNull();
  });

  it("every RowActions button has type='button'", () => {
    render(
      wrap(
        mockClient(),
        <>
          <CheckOutButton fileId={"f1" as any} />
          <CheckInButton fileId={"f1" as any} localFile={localFile as any} />
          <CancelButton fileId={"f1" as any} />
        </>,
      ),
    );
    for (const btn of screen.getAllByRole("button")) {
      expect(btn).toHaveAttribute("type", "button");
    }
  });
});
