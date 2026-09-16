import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { SettingsDialog } from "../SettingsDialog";
import { DEFAULT_PREFS, PREFS_KEY, usePrefs } from "../../lib/prefs";
import type { UpdaterApi } from "../../lib/use-updater";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(true)) }));
vi.mock("@tauri-apps/api/path", () => ({ appLocalDataDir: vi.fn(() => Promise.resolve("C:/x")) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(() => Promise.resolve(true)),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));

const updater: UpdaterApi = {
  state: { kind: "up_to_date", current: "5.7.3" },
  recheck: vi.fn(),
  installAndRelaunch: vi.fn(() => Promise.resolve()),
};

function renderDialog(extra: Partial<ComponentProps<typeof SettingsDialog>> = {}) {
  return render(
    <SettingsDialog
      open
      onClose={vi.fn()}
      appVersion="5.7.3"
      updater={updater}
      onOpenUpdate={vi.fn()}
      onOpenReport={vi.fn()}
      onGoToVaultSettings={vi.fn()}
      account={{ email: "a@b.c", id: "12345678-x", role: "Owner" }}
      {...extra}
    />,
  );
}

beforeEach(() => {
  localStorage.clear();
  usePrefs.setState({ prefs: DEFAULT_PREFS });
});

describe("SettingsDialog", () => {
  it("opens on General and switches tabs", () => {
    renderDialog();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "Landing module" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    expect(screen.getByRole("switch", { name: "Show desktop notifications" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "About" }));
    expect(screen.getByText(/Version 5\.7\.3/)).toBeTruthy();
    expect(screen.getByText("a@b.c")).toBeTruthy();
  });

  it("honours initialTab", () => {
    renderDialog({ initialTab: "shortcuts" });
    expect(screen.getByText("Open Settings")).toBeTruthy();
  });

  it("persists the landing choice and auto-update toggle to helios:prefs", () => {
    renderDialog();
    fireEvent.click(screen.getByRole("radio", { name: "Last used" }));
    fireEvent.click(screen.getByRole("switch", { name: "Install updates automatically" }));
    const stored = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
    expect(stored.landing).toBe("last");
    expect(stored.autoUpdate).toBe(false);
    expect(usePrefs.getState().prefs.landing).toBe("last");
  });

  it("disables per-source switches when the master switch is off", () => {
    renderDialog({ initialTab: "notifications" });
    const vault = screen.getByRole("switch", { name: "Vault sync warnings" }) as HTMLButtonElement;
    expect(vault.disabled).toBe(false);
    fireEvent.click(screen.getByRole("switch", { name: "Show desktop notifications" }));
    expect(vault.disabled).toBe(true);
    expect(usePrefs.getState().prefs.notifications.enabled).toBe(false);
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    renderDialog({ onClose });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("renders nothing when closed", () => {
    const { container } = renderDialog({ open: false });
    expect(container.innerHTML).toBe("");
  });
});
