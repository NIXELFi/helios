import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Vault } from "../../data/types";

const rpc = vi.fn();
// One object: the real hook returns a stable client, and the load effect depends on it.
const client = { rpc };
vi.mock("@helios/auth", () => ({ useSupabaseClient: () => client }));
vi.mock("../../data/vault-files-context", () => ({
  useVaultFiles: () => ({
    data: [
      { id: "asm27", name: "SDM27-Master-Assembly.SLDASM", folder_id: null },
      { id: "sub27", name: "Front-Suspension.SLDASM", folder_id: null },
    ],
  }),
}));
vi.mock("../../data/useFolders", () => ({ useFolders: () => ({ data: [] }) }));

import { AssemblyAlertSettings } from "../AssemblyAlertSettings";

const VAULT = { id: "v27", name: "SDM27", spotlight_file_id: "asm27" } as unknown as Vault;
const URL = "https://hooks.slack.com/triggers/T0/1/abc";

function stubGet(row: Record<string, unknown>) {
  rpc.mockImplementation(async (name: string) => {
    if (name === "assembly_alert_get") return { data: [row], error: null };
    return { data: null, error: null };
  });
}

const setCalls = () => rpc.mock.calls.filter(([name]) => name === "assembly_alert_set");

describe("AssemblyAlertSettings", () => {
  beforeEach(() => rpc.mockReset());

  it("starts an unconfigured car on its spotlight file, switched off", async () => {
    stubGet({ enabled: false, file_id: null, file_name: null, has_webhook: false });
    render(<AssemblyAlertSettings vault={VAULT} />);
    expect(await screen.findByText("SDM27-Master-Assembly.SLDASM")).toBeTruthy();
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    expect(screen.getByPlaceholderText("https://hooks.slack.com/...")).toBeTruthy();
  });

  it("saves the toggle, file and webhook for this vault, then clears the URL field", async () => {
    stubGet({ enabled: false, file_id: null, file_name: null, has_webhook: false });
    render(<AssemblyAlertSettings vault={VAULT} />);
    fireEvent.click(await screen.findByRole("checkbox"));
    const input = screen.getByPlaceholderText("https://hooks.slack.com/...") as HTMLInputElement;
    fireEvent.change(input, { target: { value: `  ${URL} ` } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText("Saved.");
    expect(setCalls()).toEqual([
      ["assembly_alert_set", { p_vault_id: "v27", p_enabled: true, p_file_id: "asm27", p_webhook_url: URL }],
    ]);
    expect(input.value).toBe("");
  });

  it("sends a null webhook when the field is empty, keeping the saved one", async () => {
    stubGet({ enabled: true, file_id: "asm27", file_name: "SDM27-Master-Assembly.SLDASM", has_webhook: true });
    render(<AssemblyAlertSettings vault={VAULT} />);
    expect(await screen.findByPlaceholderText("Saved. Paste a new URL to replace it.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved.");
    expect(setCalls()[0]![1]).toMatchObject({ p_enabled: true, p_webhook_url: null });
  });

  it("switches file through the picker", async () => {
    stubGet({ enabled: true, file_id: "asm27", file_name: "SDM27-Master-Assembly.SLDASM", has_webhook: true });
    render(<AssemblyAlertSettings vault={VAULT} />);
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    expect(screen.getByRole("dialog", { name: "Choose assembly" })).toBeTruthy();
    expect(screen.queryByText("Clear spotlight")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Front-Suspension/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(setCalls()[0]![1]).toMatchObject({ p_file_id: "sub27" }));
  });

  it("shows the server's refusal and keeps the typed URL", async () => {
    rpc.mockImplementation(async (name: string) => {
      if (name === "assembly_alert_get") {
        return { data: [{ enabled: false, file_id: "asm27", file_name: "SDM27-Master-Assembly.SLDASM", has_webhook: false }], error: null };
      }
      return { data: null, error: { message: "That does not look like a Slack webhook URL" } };
    });
    render(<AssemblyAlertSettings vault={VAULT} />);
    const input = (await screen.findByPlaceholderText("https://hooks.slack.com/...")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "https://evil.example/x" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Slack webhook URL");
    expect(input.value).toBe("https://evil.example/x");
    expect(screen.queryByText("Saved.")).toBeNull();
  });
});
