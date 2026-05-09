import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { LockBadge } from "../../src/modules/vault/components/LockBadge";

describe("<LockBadge>", () => {
  it("renders 'Up to date' when state is latest", () => {
    render(<LockBadge state="latest" />);
    expect(screen.getByText(/up to date/i)).toBeInTheDocument();
  });

  it("renders 'Locked by me' when state is locked-by-me", () => {
    render(<LockBadge state="locked-by-me" />);
    expect(screen.getByText(/locked by me/i)).toBeInTheDocument();
  });

  it("renders the holder name when state is locked-by-other", () => {
    render(<LockBadge state="locked-by-other" holderEmail="alice@x.com" />);
    expect(screen.getByText(/alice@x\.com/)).toBeInTheDocument();
  });
});
