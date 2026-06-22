/**
 * Regression for H-9: CheckOutButton's re-click guard must NOT reset in the
 * try/finally while the where-used confirm dialog is still open. If it did, a
 * second click would re-enter and fire a concurrent doCheckOut() →
 * acquireLock.run() twice (duplicate lock RPC). The guard is released only when
 * the dialog resolves (confirm OR close).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// Tauri shims (RowActions imports them at module load).
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("../../data/fs-readonly", () => ({ setReadonly: vi.fn(), flipSwReadonly: vi.fn() }));
vi.mock("@helios/auth", () => ({ useSupabaseClient: () => ({}) }));

// acquireLock.run — the call we must ensure fires AT MOST once per checkout.
const acquireRun = vi.fn();
vi.mock("../../data/useAcquireLock", () => ({
  useAcquireLock: () => ({ run: acquireRun, loading: false, error: null }),
}));
vi.mock("../../data/useReleaseLock", () => ({ useReleaseLock: () => ({ run: vi.fn(), loading: false, error: null }) }));
vi.mock("../../data/useCheckIn", () => ({ useCheckIn: () => ({ run: vi.fn(), loading: false, error: null }) }));
vi.mock("../../data/useDeleteFile", () => ({ useDeleteFile: () => ({ run: vi.fn(), loading: false, error: null }) }));
vi.mock("../../data/useDownloadVersion", () => ({ useDownloadVersion: () => ({ run: vi.fn(), loading: false, error: null }) }));
vi.mock("../../data/useRecordRefs", () => ({ useRecordRefs: () => ({ run: vi.fn() }) }));
vi.mock("../../data/useRecordProperties", () => ({ useRecordProperties: () => ({ run: vi.fn() }) }));
vi.mock("../../data/useRestoreVersion", () => ({ useRestoreVersion: () => ({ run: vi.fn(), loading: false, error: null }) }));

// Force a where-used warning so the confirm dialog opens and the guard must
// stay held while it's up.
vi.mock("../../data/useReferences", () => ({ fetchWhereUsed: vi.fn().mockResolvedValue([{ id: "p1" }]) }));
vi.mock("../../data/whereUsedWarning", () => ({
  whereUsedWarning: () => ({ message: "Used by 1 assembly." }),
}));

import { CheckOutButton } from "../RowActions";

beforeEach(() => {
  acquireRun.mockReset();
  acquireRun.mockResolvedValue(null); // null = no lock acquired; we only count calls
});

describe("CheckOutButton re-click guard (H-9)", () => {
  it("keeps the button disabled while the where-used confirm dialog is open", async () => {
    render(<CheckOutButton fileId="f1" fileName="frame.SLDPRT" />);
    // Exact name avoids matching the dialog's "Check Out Anyway" button.
    const btn = screen.getByRole("button", { name: "Check Out" }) as HTMLButtonElement;

    fireEvent.click(btn);

    // Once the warning resolves, the confirm dialog appears AND the trigger
    // button stays disabled (guard held) — a second click can't re-enter.
    await waitFor(() => {
      expect(screen.getByText("Used by 1 assembly.")).toBeTruthy();
    });
    expect(btn.disabled).toBe(true);

    // A rapid second click while the dialog is open must be a no-op: doCheckOut
    // (and thus acquireLock.run) has NOT fired yet.
    fireEvent.click(btn);
    expect(acquireRun).not.toHaveBeenCalled();
  });

  it("releases the guard after the dialog is cancelled (button re-enabled)", async () => {
    render(<CheckOutButton fileId="f1" fileName="frame.SLDPRT" />);
    const btn = screen.getByRole("button", { name: "Check Out" }) as HTMLButtonElement;

    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByText("Used by 1 assembly.")).toBeTruthy());

    // Cancel the dialog → guard cleared, button enabled again.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(btn.disabled).toBe(false));
  });

  it("confirming the dialog runs exactly one checkout", async () => {
    render(<CheckOutButton fileId="f1" fileName="frame.SLDPRT" />);
    const btn = screen.getByRole("button", { name: "Check Out" }) as HTMLButtonElement;

    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByText("Used by 1 assembly.")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Check Out Anyway" }));
    await waitFor(() => expect(acquireRun).toHaveBeenCalledTimes(1));
  });
});
