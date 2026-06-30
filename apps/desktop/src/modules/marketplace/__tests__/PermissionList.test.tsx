import { afterEach, describe, it, expect } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PermissionList, hasHighTrust } from "../components/PermissionList";

afterEach(cleanup);

describe("PermissionList", () => {
  it("renders an explicit 'Sandboxed' affordance for a pure plugin", () => {
    render(<PermissionList permissions={[]} mode="badge" />);
    expect(screen.getByText(/sandboxed/i)).toBeTruthy();
  });

  it("shows the Tier-2 catalog description + high-trust label in detail mode", () => {
    render(<PermissionList permissions={["engine:matlab"]} mode="detail" />);
    expect(screen.getByText("engine:matlab")).toBeTruthy();
    expect(screen.getByText(/high trust/i)).toBeTruthy();
    // The exact consent copy comes from the SDK CAPABILITIES catalog.
    expect(screen.getByText(/run matlab programs on this computer/i)).toBeTruthy();
  });

  it("renders Tier-1 permissions without the high-trust treatment", () => {
    render(<PermissionList permissions={["storage", "file.read"]} mode="detail" />);
    expect(screen.getByText("storage")).toBeTruthy();
    expect(screen.getByText("file.read")).toBeTruthy();
    expect(screen.queryByText(/high trust/i)).toBeNull();
  });

  it("ignores unknown permission keys (default-deny: only catalog doors render)", () => {
    render(<PermissionList permissions={["totally.bogus"]} mode="badge" />);
    // Falls back to the empty/sandboxed affordance rather than rendering junk.
    expect(screen.getByText(/sandboxed/i)).toBeTruthy();
    expect(screen.queryByText("totally.bogus")).toBeNull();
  });
});

describe("hasHighTrust", () => {
  it("is true only when a Tier-2 permission is present", () => {
    expect(hasHighTrust(["engine:matlab"])).toBe(true);
    expect(hasHighTrust(["storage", "file.read", "file.write"])).toBe(false);
    expect(hasHighTrust([])).toBe(false);
  });
});
