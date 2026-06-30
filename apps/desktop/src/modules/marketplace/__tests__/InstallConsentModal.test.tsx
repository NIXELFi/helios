import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { InstallConsentModal } from "../components/InstallConsentModal";
import { makePlugin } from "./_fixtures";

afterEach(cleanup);

describe("InstallConsentModal", () => {
  it("warns loudly for a high-trust (Tier-2) add-on", () => {
    render(
      <InstallConsentModal
        plugin={makePlugin({ permissions: ["engine:matlab"] })}
        installing={false}
        error={null}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText(/run code outside the sandbox/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /install anyway/i })).toBeTruthy();
  });

  it("has no high-trust banner for a sandboxed/Tier-1 add-on", () => {
    render(
      <InstallConsentModal
        plugin={makePlugin({ permissions: ["storage"] })}
        installing={false}
        error={null}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.queryByText(/run code outside the sandbox/i)).toBeNull();
    expect(screen.getByRole("button", { name: /^install$/i })).toBeTruthy();
  });

  it("confirms and cancels through the right callbacks", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <InstallConsentModal
        plugin={makePlugin({ permissions: ["storage"] })}
        installing={false}
        error={null}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^install$/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("disables the actions while an install is in flight", () => {
    render(
      <InstallConsentModal
        plugin={makePlugin({ permissions: ["storage"] })}
        installing
        error={null}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect((screen.getByRole("button", { name: /installing/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});
