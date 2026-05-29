import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SupabaseAuthProvider } from "@helios/auth";
import { AdminScreen } from "../src/modules/vault/screens/AdminScreen";
import type { VaultUser } from "../src/modules/vault/data/types";

interface Opts {
  meId: string;
  isAdmin: boolean;
  isOwner: boolean;
  users: VaultUser[];
}

function makeClient(opts: Opts) {
  const calls: { name: string; args: any }[] = [];
  const client = {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: opts.meId, email: "me@x.com" } } },
        error: null,
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    rpc: vi.fn((name: string, args: any) => {
      calls.push({ name, args });
      switch (name) {
        case "pdm_is_admin": return Promise.resolve({ data: opts.isAdmin, error: null });
        case "pdm_is_owner": return Promise.resolve({ data: opts.isOwner, error: null });
        case "pdm_admin_list_users": return Promise.resolve({ data: opts.users, error: null });
        case "pdm_set_user_role": return Promise.resolve({ data: null, error: null });
        case "pdm_revoke_user_role": return Promise.resolve({ data: null, error: null });
        default: return Promise.resolve({ data: null, error: null });
      }
    }),
    // The SubteamsPanel reads pdm.subteams via from().select().order().
    from: () => ({
      select: () => ({
        order: () => Promise.resolve({
          data: [{ id: "st1", name: "Engine", sort_order: 1 }],
          error: null,
        }),
      }),
    }),
  } as any;
  return { client, calls };
}

const USERS: VaultUser[] = [
  { user_id: "owner-1", email: "owner@x.com", display_name: "Owner One", subteam: "Engine", role: "owner", granted_at: "2026-01-01", created_at: "2026-01-01" },
  { user_id: "admin-1", email: "admin@x.com", display_name: "Admin One", subteam: "Brakes", role: "admin", granted_at: "2026-01-02", created_at: "2026-01-02" },
  { user_id: "viewer-1", email: "viewer@x.com", display_name: "Viewer One", subteam: "Aero Design", role: "viewer", granted_at: "2026-01-03", created_at: "2026-01-03" },
  { user_id: "new-1", email: "new@x.com", display_name: "New User", subteam: "Finance", role: null, granted_at: null, created_at: "2026-01-04" },
];

function renderScreen(opts: Opts) {
  const { client, calls } = makeClient(opts);
  render(
    <SupabaseAuthProvider client={client}>
      <AdminScreen />
    </SupabaseAuthProvider>,
  );
  return { calls };
}

describe("<AdminScreen>", () => {
  it("lists every user with their role", async () => {
    renderScreen({ meId: "owner-1", isAdmin: true, isOwner: true, users: USERS });
    await waitFor(() => expect(screen.getByText("owner@x.com")).toBeInTheDocument());
    expect(screen.getByText("admin@x.com")).toBeInTheDocument();
    expect(screen.getByText("viewer@x.com")).toBeInTheDocument();
    expect(screen.getByText("new@x.com")).toBeInTheDocument();
    // The no-role user shows a "no access" badge.
    expect(screen.getByText(/no access/i)).toBeInTheDocument();
  });

  it("owner can promote a viewer to admin", async () => {
    const { calls } = renderScreen({ meId: "owner-1", isAdmin: true, isOwner: true, users: USERS });
    // Wait for the async useIsOwner() effect to resolve — the header subtitle
    // only shows this copy once isOwner is true, which is what enables the
    // admin option.
    await screen.findByText(/grant any role, including admin/i);
    const sel = screen.getByLabelText("Set role for viewer@x.com");
    const adminOpt = within(sel).getByRole("option", { name: "admin" }) as HTMLOptionElement;
    expect(adminOpt.disabled).toBe(false);
    fireEvent.change(sel, { target: { value: "admin" } });
    await waitFor(() =>
      expect(calls.some((c) => c.name === "pdm_set_user_role" && c.args.p_target === "viewer-1" && c.args.p_role === "admin")).toBe(true),
    );
  });

  it("non-owner admin cannot assign admin (option disabled) and cannot edit an admin row", async () => {
    renderScreen({ meId: "admin-1", isAdmin: true, isOwner: false, users: USERS });
    await screen.findByText(/only the owner can grant the admin role/i);
    const viewerSel = (await screen.findByLabelText("Set role for viewer@x.com")) as HTMLSelectElement;
    // The 'admin' option is disabled for a non-owner.
    const adminOpt = within(viewerSel).getByRole("option", { name: "admin" }) as HTMLOptionElement;
    expect(adminOpt.disabled).toBe(true);
    // The existing admin row's select is entirely disabled (owner-only).
    const adminRowSel = screen.getByLabelText("Set role for admin@x.com") as HTMLSelectElement;
    expect(adminRowSel.disabled).toBe(true);
  });

  it("revokes a viewer", async () => {
    const { calls } = renderScreen({ meId: "owner-1", isAdmin: true, isOwner: true, users: USERS });
    // Wait until admin/owner state has resolved so the row's Revoke button is
    // editable (clicking it while still disabled would be a no-op).
    await screen.findByText(/grant any role, including admin/i);
    const row = screen.getByText("viewer@x.com").closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: /revoke/i }));
    await waitFor(() =>
      expect(calls.some((c) => c.name === "pdm_revoke_user_role" && c.args.p_target === "viewer-1")).toBe(true),
    );
  });

  it("marks your own row and disables its controls", async () => {
    renderScreen({ meId: "owner-1", isAdmin: true, isOwner: true, users: USERS });
    await screen.findByText("owner@x.com");
    expect(screen.getByText("(you)")).toBeInTheDocument();
    const myRow = screen.getByText("owner@x.com").closest("tr")!;
    expect(within(myRow).getByRole("combobox")).toBeDisabled();
    expect(within(myRow).getByRole("button", { name: /revoke/i })).toBeDisabled();
  });
});
