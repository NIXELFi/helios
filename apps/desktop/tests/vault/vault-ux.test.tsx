import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { Breadcrumbs } from "../../src/modules/vault/components/Breadcrumbs";
import { VaultSearch } from "../../src/modules/vault/components/VaultSearch";
import { ToastHost } from "../../src/modules/vault/components/ToastHost";
import { toast, resetToasts } from "../../src/modules/vault/data/toast";

beforeEach(() => resetToasts());

const FOLDERS = [
  { id: "f-chassis", vault_id: "v1", parent_id: null, name: "Chassis", created_at: "x" },
  { id: "f-sub", vault_id: "v1", parent_id: "f-chassis", name: "Subframe", created_at: "x" },
  { id: "f-aero", vault_id: "v1", parent_id: null, name: "Aero", created_at: "x" },
] as any[];

const FILES = [
  { id: "file-frame", vault_id: "v1", folder_id: "f-sub", name: "frame.sldprt", latest_version_id: null, created_at: "x" },
  { id: "file-wing", vault_id: "v1", folder_id: "f-aero", name: "wing.sldasm", latest_version_id: null, created_at: "x" },
  { id: "file-readme", vault_id: "v1", folder_id: null, name: "readme.md", latest_version_id: null, created_at: "x" },
] as any[];

describe("<Breadcrumbs>", () => {
  it("renders the full path and navigates on segment click", () => {
    const onNavigate = vi.fn();
    render(
      <Breadcrumbs vaultName="sdm26" folders={FOLDERS} selectedFolder="f-sub" onNavigate={onNavigate} />,
    );
    // Root + both ancestors render.
    expect(screen.getByText("sdm26")).toBeInTheDocument();
    expect(screen.getByText("Chassis")).toBeInTheDocument();
    expect(screen.getByText("Subframe")).toBeInTheDocument();
    // Current segment is inert; ancestors navigate.
    fireEvent.click(screen.getByText("Chassis"));
    expect(onNavigate).toHaveBeenCalledWith("f-chassis");
    fireEvent.click(screen.getByText("sdm26"));
    expect(onNavigate).toHaveBeenCalledWith(null);
    expect(screen.getByText("Subframe")).toBeDisabled();
  });

  it("shows just the vault chip at the root", () => {
    render(<Breadcrumbs vaultName="sdm26" folders={FOLDERS} selectedFolder={null} onNavigate={() => {}} />);
    expect(screen.getByText("sdm26")).toHaveAttribute("aria-current", "page");
    expect(screen.queryByText("Chassis")).toBeNull();
  });
});

describe("<VaultSearch>", () => {
  it("filters vault-wide, shows paths, and picks navigate to file + folder", () => {
    const onPick = vi.fn();
    render(<VaultSearch allFiles={FILES} folders={FOLDERS} onPick={onPick} />);
    const input = screen.getByRole("combobox", { name: /search files/i });
    fireEvent.change(input, { target: { value: "frame" } });
    // Hit shows name + full folder path.
    expect(screen.getByText("frame.sldprt")).toBeInTheDocument();
    expect(screen.getByText("Chassis/Subframe/frame.sldprt")).toBeInTheDocument();
    // Files that don't match are absent.
    expect(screen.queryByText("wing.sldasm")).toBeNull();
    fireEvent.click(screen.getByText("frame.sldprt"));
    expect(onPick).toHaveBeenCalledWith("file-frame", "f-sub");
  });

  it("Enter picks the active hit; Escape clears", () => {
    const onPick = vi.fn();
    render(<VaultSearch allFiles={FILES} folders={FOLDERS} onPick={onPick} />);
    const input = screen.getByRole("combobox", { name: /search files/i });
    fireEvent.change(input, { target: { value: "wing" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith("file-wing", "f-aero");
    fireEvent.change(input, { target: { value: "wing" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("shows a no-match message", () => {
    render(<VaultSearch allFiles={FILES} folders={FOLDERS} onPick={() => {}} />);
    fireEvent.change(screen.getByRole("combobox", { name: /search files/i }), {
      target: { value: "zzzzz" },
    });
    expect(screen.getByText(/no files match/i)).toBeInTheDocument();
  });
});

describe("toast bus + <ToastHost>", () => {
  it("renders pushed toasts and dismisses on click", () => {
    render(<ToastHost />);
    act(() => { toast("Checked in frame.sldprt — v4"); });
    expect(screen.getByText("Checked in frame.sldprt — v4")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /dismiss notification/i }));
    expect(screen.queryByText("Checked in frame.sldprt — v4")).toBeNull();
  });

  it("auto-dismisses after the TTL", () => {
    vi.useFakeTimers();
    try {
      render(<ToastHost />);
      act(() => { toast("transient"); });
      expect(screen.getByText("transient")).toBeInTheDocument();
      act(() => { vi.advanceTimersByTime(4100); });
      expect(screen.queryByText("transient")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
