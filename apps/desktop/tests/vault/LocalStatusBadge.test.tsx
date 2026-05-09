import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { LocalStatusBadge } from "../../src/modules/vault/components/LocalStatusBadge";

describe("<LocalStatusBadge>", () => {
  it("renders 'Synced' for synced status", () => {
    render(<LocalStatusBadge status="synced" />);
    expect(screen.getByText("Synced")).toBeInTheDocument();
  });

  it("renders 'Modified' for modified status", () => {
    render(<LocalStatusBadge status="modified" />);
    expect(screen.getByText("Modified")).toBeInTheDocument();
  });

  it("renders 'Not local' for vault-only status", () => {
    render(<LocalStatusBadge status="vault-only" />);
    expect(screen.getByText("Not local")).toBeInTheDocument();
  });

  it("renders nothing for no-folder status", () => {
    const { container } = render(<LocalStatusBadge status="no-folder" />);
    expect(container.firstChild).toBeNull();
  });
});
