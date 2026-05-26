import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SupabaseAuthProvider } from "@helios/auth";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NavRail } from "../../src/modules/vault/components/NavRail";

// The NavRail now includes a VaultSwitcher that loads `vaults` via Supabase.
// Tests render it under a mocked SupabaseAuthProvider with one vault.
function mockClient(): SupabaseClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { user: { id: "u1", email: "test@sdm.com" } } },
        error: null,
      }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    rpc: () => Promise.resolve({ data: false, error: null }),
    from: (table: string) => {
      if (table === "vaults") {
        return {
          select: () => Promise.resolve({
            data: [{
              id: "v1", name: "SDM26",
              created_at: "2026-05-11T18:32:17.728358+00:00",
              created_by: "u1",
            }],
            error: null,
          }),
        };
      }
      return { select: () => Promise.resolve({ data: [], error: null }) };
    },
  } as any;
}

function renderRail(props: { active: "browse" | "history" | "who" | "settings"; onSelect?: (id: any) => void }) {
  return render(
    <SupabaseAuthProvider client={mockClient()}>
      <NavRail active={props.active} onSelect={props.onSelect ?? (() => {})} />
    </SupabaseAuthProvider>,
  );
}

describe("<NavRail>", () => {
  beforeEach(() => localStorage.clear());

  it("renders Browse / History / Who has what entries", () => {
    renderRail({ active: "browse" });
    expect(screen.getByRole("button", { name: /^browse$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^history$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^who has what$/i })).toBeInTheDocument();
  });

  it("marks the active entry with aria-current", () => {
    renderRail({ active: "who" });
    expect(screen.getByRole("button", { name: /^who has what$/i })).toHaveAttribute("aria-current", "page");
  });

  it("calls onSelect on click", () => {
    const onSelect = vi.fn();
    renderRail({ active: "browse", onSelect });
    fireEvent.click(screen.getByRole("button", { name: /^history$/i }));
    expect(onSelect).toHaveBeenCalledWith("history");
  });
});
