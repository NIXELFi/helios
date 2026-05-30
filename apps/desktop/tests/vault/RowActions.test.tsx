import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SupabaseAuthProvider } from "@helios/auth";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CheckInButton, CheckOutButton, CancelButton } from "../../src/modules/vault/components/RowActions";

// Mock Tauri plugins so tests don't need a real Tauri runtime. readFile is the
// source of the bytes that get checked in; the dialog open() picks the file
// when there's no localFile prop.
const readFileMock = vi.fn(async () => new Uint8Array([1, 2, 3, 4]));
vi.mock("@tauri-apps/plugin-fs", () => ({
  readFile: (...args: unknown[]) => readFileMock(...(args as [])),
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

  it("CancelButton surfaces a release-lock failure via title", async () => {
    render(wrap(mockClient({ rpcError: { message: "no active lock" } }), <CancelButton fileId={"f1" as any} />));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await waitFor(() => {
      const btn = screen.getByRole("button", { name: /cancel|retry/i });
      expect(btn.getAttribute("title")).toMatch(/no active lock|lock/i);
    });
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
