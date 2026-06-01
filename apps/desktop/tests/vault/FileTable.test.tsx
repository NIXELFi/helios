import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SupabaseAuthProvider } from "@helios/auth";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FileTable } from "../../src/modules/vault/components/FileTable";

// Mock Tauri plugins so tests don't need a real Tauri runtime.
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue("/tmp/fake.sldprt"),
  save: vi.fn().mockResolvedValue("/tmp/picked-save.sldprt"),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  readFile: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
}));

const files = [
  { id: "f1", vault_id: "v", folder_id: null, name: "frame.sldprt", latest_version_id: "ver1", created_at: "2026-01-01" },
  { id: "f2", vault_id: "v", folder_id: null, name: "wheel.sldprt", latest_version_id: null, created_at: "2026-01-01" },
];

function mockClient(overrides: Partial<SupabaseClient> = {}): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: "u1" } } },
        error: null,
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    from: (table: string) => {
      if (table === "locks") {
        return {
          insert: () => ({
            select: () => ({
              single: () =>
                Promise.resolve({
                  data: { id: "l1", file_id: "f1", user_id: "u1", acquired_at: "x", released_at: null, force_released_by: null },
                  error: null,
                }),
            }),
          }),
        };
      }
      return { select: () => Promise.resolve({ data: [], error: null }) };
    },
    ...overrides,
  } as any;
}

function wrap(client: SupabaseClient, children: React.ReactNode) {
  return <SupabaseAuthProvider client={client}>{children}</SupabaseAuthProvider>;
}

describe("<FileTable>", () => {
  it("renders one row per file", () => {
    render(
      wrap(
        mockClient(),
        <FileTable files={files} selected={null} locks={[]} currentUserId="u" onSelect={() => {}} />,
      ),
    );
    expect(screen.getByText("frame.sldprt")).toBeInTheDocument();
    expect(screen.getByText("wheel.sldprt")).toBeInTheDocument();
  });

  it("emits onSelect when a row is clicked", () => {
    const onSelect = vi.fn();
    render(
      wrap(
        mockClient(),
        <FileTable files={files} selected={null} locks={[]} currentUserId="u" onSelect={onSelect} />,
      ),
    );
    fireEvent.click(screen.getByText("frame.sldprt"));
    expect(onSelect).toHaveBeenCalledWith("f1");
  });

  it("shows 'Locked by me' badge when current user holds the lock", () => {
    const locks = [{ id: "l1", file_id: "f1", user_id: "u", acquired_at: "x", released_at: null, force_released_by: null }];
    render(
      wrap(
        mockClient(),
        <FileTable files={files} selected={null} locks={locks as any} currentUserId="u" onSelect={() => {}} />,
      ),
    );
    expect(screen.getByText(/locked by me/i)).toBeInTheDocument();
  });

  it("Check Out button appears on a non-locked file when canEdit", async () => {
    render(
      wrap(
        mockClient(),
        <FileTable files={files} selected={null} locks={[]} currentUserId="u1" canEdit={true} onSelect={() => {}} />,
      ),
    );
    // One Check Out per unlocked file
    const btns = await screen.findAllByRole("button", { name: /check out/i });
    expect(btns.length).toBe(2);
  });

  it("Check Out button is hidden when canEdit is false", () => {
    render(
      wrap(
        mockClient(),
        <FileTable files={files} selected={null} locks={[]} currentUserId="u1" canEdit={false} onSelect={() => {}} />,
      ),
    );
    expect(screen.queryByRole("button", { name: /check out/i })).toBeNull();
  });

  it("Locked-by-me row shows Check In and Cancel buttons", () => {
    const locks = [{ id: "l1", file_id: "f1", user_id: "u1", acquired_at: "x", released_at: null, force_released_by: null }];
    render(
      wrap(
        mockClient(),
        <FileTable files={files} selected={null} locks={locks as any} currentUserId="u1" canEdit={true} onSelect={() => {}} />,
      ),
    );
    expect(screen.getByRole("button", { name: /check in/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
  });

  it("Click on action button does not trigger row onSelect", async () => {
    const onSelect = vi.fn();
    render(
      wrap(
        mockClient(),
        <FileTable files={files} selected={null} locks={[]} currentUserId="u1" canEdit={true} onSelect={onSelect} />,
      ),
    );
    const btns = await screen.findAllByRole("button", { name: /check out/i });
    fireEvent.click(btns[0]);
    // onSelect must NOT be called
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("renders checkboxes when selectedIds prop is provided", () => {
    render(
      wrap(
        mockClient(),
        <FileTable
          files={files}
          selected={null}
          locks={[]}
          currentUserId="u1"
          onSelect={() => {}}
          selectedIds={new Set()}
          onToggleSelect={() => {}}
          onToggleSelectAll={() => {}}
          allSelected={false}
        />,
      ),
    );
    // One per row + one header checkbox
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes.length).toBe(files.length + 1); // header + one per file
  });

  it("clicking a row checkbox calls onToggleSelect with the file id", () => {
    const onToggleSelect = vi.fn();
    render(
      wrap(
        mockClient(),
        <FileTable
          files={files}
          selected={null}
          locks={[]}
          currentUserId="u1"
          onSelect={() => {}}
          selectedIds={new Set()}
          onToggleSelect={onToggleSelect}
          onToggleSelectAll={() => {}}
          allSelected={false}
        />,
      ),
    );
    const checkboxes = screen.getAllByRole("checkbox");
    // First checkbox is the header; second is for files[0]
    fireEvent.click(checkboxes[1]);
    expect(onToggleSelect).toHaveBeenCalledWith("f1");
  });

  it("clicking the cell padding around a checkbox toggles selection without opening the file detail panel", () => {
    // Regression guard for the 2026-05-25 audit: clicking on the
    // <td> padding around the small checkbox used to fall through to the
    // row's onClick (which opens the file detail panel). The fix moved
    // stopPropagation + onToggleSelect onto the cell wrapper so clicks in
    // the cell's padding still toggle and never trigger row selection.
    const onSelect = vi.fn();
    const onToggleSelect = vi.fn();
    render(
      wrap(
        mockClient(),
        <FileTable
          files={files}
          selected={null}
          locks={[]}
          currentUserId="u1"
          onSelect={onSelect}
          selectedIds={new Set()}
          onToggleSelect={onToggleSelect}
          onToggleSelectAll={() => {}}
          allSelected={false}
        />,
      ),
    );
    const checkboxes = screen.getAllByRole("checkbox");
    // Click the checkbox CELL (the <td>) — its parentElement of the input.
    const cell = checkboxes[1].parentElement as HTMLElement;
    fireEvent.click(cell);
    expect(onToggleSelect).toHaveBeenCalledWith("f1");
    // Row's onClick must NOT have fired — that would have opened the file
    // detail panel for a click the user intended as a selection toggle.
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("header checkbox calls onToggleSelectAll", () => {
    const onToggleSelectAll = vi.fn();
    render(
      wrap(
        mockClient(),
        <FileTable
          files={files}
          selected={null}
          locks={[]}
          currentUserId="u1"
          onSelect={() => {}}
          selectedIds={new Set()}
          onToggleSelect={() => {}}
          onToggleSelectAll={onToggleSelectAll}
          allSelected={false}
        />,
      ),
    );
    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[0]); // header checkbox
    expect(onToggleSelectAll).toHaveBeenCalled();
  });

  it("shows the local sync state in the consolidated Status pill", () => {
    const localFiles = [
      { basename: "frame.sldprt", relativePath: "frame.sldprt", absolutePath: "/x/frame.sldprt", sha256: "abc", sizeBytes: 1 },
    ];
    // No matching version → "modified" status for frame.sldprt; wheel.sldprt has no local match → "vault-only" → "Not local"
    render(
      wrap(
        mockClient(),
        <FileTable
          files={files}
          selected={null}
          locks={[]}
          currentUserId="u1"
          onSelect={() => {}}
          localFiles={localFiles}
          versionsByFileId={new Map()}
        />,
      ),
    );
    expect(screen.getByText("Modified")).toBeInTheDocument();
    expect(screen.getByText("Not local")).toBeInTheDocument();
  });

  it("does not show local-state labels when localFiles prop is omitted", () => {
    render(
      wrap(
        mockClient(),
        <FileTable files={files} selected={null} locks={[]} currentUserId="u1" onSelect={() => {}} />,
      ),
    );
    // Without localFiles, the Status column shows the placeholder neutral pill.
    expect(screen.queryByText("Modified")).toBeNull();
    expect(screen.queryByText("Not local")).toBeNull();
    expect(screen.queryByText("Synced")).toBeNull();
  });

  it("manual mode shows a Download button on every file with a latest version, even when localMatch is synced", () => {
    // f1 has a version + a synced local file → in auto mode no button would show.
    // In manual mode the button must still appear because the user opted out
    // of auto-sync and the row action is their only download path.
    const versions = new Map([
      ["f1", [{ id: "ver1", file_id: "f1", version_num: 1, sha256: "abc123", size_bytes: 10, author_id: "u1", comment: null, parent_version_id: null, created_at: "x" }]],
    ]);
    const localFiles = [
      { basename: "frame.sldprt", relativePath: "frame.sldprt", absolutePath: "/x/frame.sldprt", sha256: "abc123", sizeBytes: 10 },
    ];
    render(
      wrap(
        mockClient(),
        <FileTable
          files={files}
          selected={null}
          locks={[]}
          currentUserId="u1"
          onSelect={() => {}}
          localFiles={localFiles}
          versionsByFileId={versions}
          vaultRoot="/Users/me/Vault"
          folders={[]}
          downloadMode="manual"
        />,
      ),
    );
    // Manual-mode label is "Download", not "Get Latest"
    expect(screen.getByRole("button", { name: /^download$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /get latest/i })).toBeNull();
  });

  it("manual mode shows Download even when no vault folder is configured (uses save dialog)", () => {
    // No vault folder + manual mode → auto mode would hide the button, but
    // manual mode keeps it so the user can pick a destination via save dialog.
    const versions = new Map([
      ["f1", [{ id: "ver1", file_id: "f1", version_num: 1, sha256: "abc123", size_bytes: 10, author_id: "u1", comment: null, parent_version_id: null, created_at: "x" }]],
    ]);
    render(
      wrap(
        mockClient(),
        <FileTable
          files={files}
          selected={null}
          locks={[]}
          currentUserId="u1"
          onSelect={() => {}}
          localFiles={null}
          versionsByFileId={versions}
          vaultRoot={null}
          folders={[]}
          downloadMode="manual"
        />,
      ),
    );
    expect(screen.getByRole("button", { name: /^download$/i })).toBeInTheDocument();
  });

  it("auto mode hides the download button when vaultRoot is null (legacy behavior)", () => {
    const versions = new Map([
      ["f1", [{ id: "ver1", file_id: "f1", version_num: 1, sha256: "abc123", size_bytes: 10, author_id: "u1", comment: null, parent_version_id: null, created_at: "x" }]],
    ]);
    render(
      wrap(
        mockClient(),
        <FileTable
          files={files}
          selected={null}
          locks={[]}
          currentUserId="u1"
          onSelect={() => {}}
          localFiles={null}
          versionsByFileId={versions}
          vaultRoot={null}
          folders={[]}
          downloadMode="auto"
        />,
      ),
    );
    expect(screen.queryByRole("button", { name: /get latest/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^download$/i })).toBeNull();
  });

  it("renders an empty-state row when there are no files (X5)", () => {
    render(
      wrap(
        mockClient(),
        <FileTable files={[]} selected={null} locks={[]} currentUserId="u1" onSelect={() => {}} />,
      ),
    );
    expect(screen.getByText(/no files in this folder/i)).toBeInTheDocument();
    // The header must still render; the empty state is a body row, not a
    // replacement for the whole table.
    expect(screen.getByText("Name")).toBeInTheDocument();
  });

  it("clickable rows are keyboard-accessible and fire onSelect on Enter (a11y)", () => {
    const onSelect = vi.fn();
    render(
      wrap(
        mockClient(),
        <FileTable files={files} selected={null} locks={[]} currentUserId="u1" onSelect={onSelect} />,
      ),
    );
    const row = screen.getByText("frame.sldprt").closest("tr") as HTMLElement;
    expect(row).toHaveAttribute("tabindex", "0");
    expect(row).toHaveAttribute("role", "button");
    fireEvent.keyDown(row, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("f1");
  });

  it("rows fire onSelect on Space (a11y)", () => {
    const onSelect = vi.fn();
    render(
      wrap(
        mockClient(),
        <FileTable files={files} selected={null} locks={[]} currentUserId="u1" onSelect={onSelect} />,
      ),
    );
    const row = screen.getByText("wheel.sldprt").closest("tr") as HTMLElement;
    fireEvent.keyDown(row, { key: " " });
    expect(onSelect).toHaveBeenCalledWith("f2");
  });

  it("renders an 'Open in SolidWorks' badge for a file whose relativePath is in openInSw", () => {
    // frame.sldprt (f1) is at root → relativePath "frame.sldprt". A `~$` lock
    // file for it was seen by the scan, so its path is in openInSw → the badge
    // renders. wheel.sldprt (f2) is not open → no badge.
    render(
      wrap(
        mockClient(),
        <FileTable
          files={files}
          selected={null}
          locks={[]}
          currentUserId="u1"
          onSelect={() => {}}
          localFiles={[]}
          versionsByFileId={new Map()}
          folders={[]}
          openInSw={new Set(["frame.sldprt"])}
        />,
      ),
    );
    const badges = screen.getAllByText(/open in solidworks/i);
    expect(badges).toHaveLength(1);
  });

  it("does not render the 'Open in SolidWorks' badge when openInSw is empty", () => {
    render(
      wrap(
        mockClient(),
        <FileTable
          files={files}
          selected={null}
          locks={[]}
          currentUserId="u1"
          onSelect={() => {}}
          localFiles={[]}
          versionsByFileId={new Map()}
          folders={[]}
          openInSw={new Set()}
        />,
      ),
    );
    expect(screen.queryByText(/open in solidworks/i)).toBeNull();
  });

  it("does not render the 'Open in SolidWorks' badge when openInSw is omitted", () => {
    render(
      wrap(
        mockClient(),
        <FileTable files={files} selected={null} locks={[]} currentUserId="u1" onSelect={() => {}} />,
      ),
    );
    expect(screen.queryByText(/open in solidworks/i)).toBeNull();
  });

  it("resolves the openInSw key through the folder hierarchy (matches the local-match path)", () => {
    // A file inside a folder: its relativePath must include the folder name,
    // built the same way matchLocal derives it (folderPath + name). The badge
    // keys off that full path, so a bare-basename key would NOT match.
    const foldersNested = [{ id: "fold1", vault_id: "v", parent_id: null, name: "chassis", created_at: "x" }];
    const nested = [
      { id: "f3", vault_id: "v", folder_id: "fold1", name: "rail.sldprt", latest_version_id: null, created_at: "2026-01-01" },
    ];
    render(
      wrap(
        mockClient(),
        <FileTable
          files={nested}
          selected={null}
          locks={[]}
          currentUserId="u1"
          onSelect={() => {}}
          localFiles={[]}
          versionsByFileId={new Map()}
          folders={foldersNested as any}
          openInSw={new Set(["chassis/rail.sldprt"])}
        />,
      ),
    );
    expect(screen.getByText(/open in solidworks/i)).toBeInTheDocument();
  });

  it("Get Latest button appears when file is vault-only and vaultRoot + version sha are set", () => {
    // f1 has a version; f2 does not. Neither has a local file → both vault-only.
    // vaultRoot is set → Get Latest should appear for f1 (has sha) but not f2 (no sha).
    const versions = new Map([
      ["f1", [{ id: "ver1", file_id: "f1", version_num: 1, sha256: "abc123", size_bytes: 10, author_id: "u1", comment: null, parent_version_id: null, created_at: "x" }]],
    ]);
    const folders = [{ id: "fold1", vault_id: "v", parent_id: null, name: "chassis", created_at: "x" }];
    render(
      wrap(
        mockClient(),
        <FileTable
          files={files}
          selected={null}
          locks={[]}
          currentUserId="u1"
          onSelect={() => {}}
          localFiles={[]}
          versionsByFileId={versions}
          vaultRoot="/Users/me/Vault"
          folders={folders as any}
        />,
      ),
    );
    // f1 is vault-only and has a sha → Get Latest should appear
    expect(screen.getByRole("button", { name: /get latest/i })).toBeInTheDocument();
  });
});
