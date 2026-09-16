import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { RESULT_LINGER_MS, SyncStatusChip } from "../src/components/SyncStatusChip";
import {
  _resetVaultSyncStatus,
  getVaultSyncStatus,
  publishVaultSyncStatus,
  subscribeVaultSyncStatus,
} from "../src/lib/vault-sync-status";
import type { AutoSyncStatus } from "../src/modules/vault/data/useAutoSync";

const idle: AutoSyncStatus = {
  busy: false, lastDownloaded: 0, lastSkipped: 0, lastFailed: 0, lastHeldBack: 0, lastRunAt: null,
  totalTasks: 0, completedTasks: 0, totalBytes: 0, completedBytes: 0, activeFiles: [], startedAt: null,
};

beforeEach(() => _resetVaultSyncStatus());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("vault-sync-status store", () => {
  it("notifies subscribers on change and de-dupes identical publishes", () => {
    const fn = vi.fn();
    subscribeVaultSyncStatus(fn);
    publishVaultSyncStatus(idle);
    publishVaultSyncStatus(idle);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(getVaultSyncStatus()).toBe(idle);
    publishVaultSyncStatus(null);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(getVaultSyncStatus()).toBeNull();
  });
});

describe("<SyncStatusChip>", () => {
  it("renders nothing when no sync hook is mounted or the sync is idle", () => {
    const { container, rerender } = render(<SyncStatusChip onClick={() => {}} />);
    expect(container).toBeEmptyDOMElement();
    act(() => publishVaultSyncStatus(idle));
    rerender(<SyncStatusChip onClick={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows progress while busy and jumps to the Vault on click", () => {
    const onClick = vi.fn();
    render(<SyncStatusChip onClick={onClick} />);
    act(() =>
      publishVaultSyncStatus({
        ...idle, busy: true, totalTasks: 12, completedTasks: 3, totalBytes: 1000, completedBytes: 250,
        activeFiles: ["bracket.SLDPRT"], startedAt: Date.now(),
      }),
    );
    const btn = screen.getByRole("button", { name: /Vault sync: Syncing 3\/12/ });
    expect(btn).toHaveAttribute("type", "button");
    expect(btn.title).toContain("25%");
    expect(btn.title).toContain("bracket.SLDPRT");
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("keeps failures visible but lets a clean result time out", () => {
    vi.useFakeTimers();
    render(<SyncStatusChip onClick={() => {}} />);
    act(() => publishVaultSyncStatus({ ...idle, busy: true, totalTasks: 2 }));
    act(() => publishVaultSyncStatus({ ...idle, lastFailed: 2, lastRunAt: "2026-09-16T10:00:00Z" }));
    expect(screen.getByRole("button", { name: /2 failed/ })).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(RESULT_LINGER_MS * 2); });
    expect(screen.getByRole("button", { name: /2 failed/ })).toBeInTheDocument();

    act(() => publishVaultSyncStatus({ ...idle, busy: true, totalTasks: 5 }));
    act(() => publishVaultSyncStatus({ ...idle, lastDownloaded: 5, lastRunAt: "2026-09-16T10:05:00Z" }));
    expect(screen.getByRole("button", { name: /Pulled 5/ })).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(RESULT_LINGER_MS + 10); });
    expect(screen.queryByRole("button")).toBeNull();
  });
});
