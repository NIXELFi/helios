import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { LoadingScreen } from "../src/components/LoadingScreen";

afterEach(cleanup);

describe("LoadingScreen — progress a11y (L16)", () => {
  it("exposes the progress bar with ARIA value attributes", () => {
    render(<LoadingScreen progress={0.42} stage="Loading laps…" />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
    expect(bar).toHaveAttribute("aria-valuenow", "42");
  });

  it("clamps aria-valuenow to 0..100", () => {
    const { rerender } = render(<LoadingScreen progress={-1} stage="x" />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
    rerender(<LoadingScreen progress={5} stage="x" />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
  });

  it("renders the error branch as an alert instead of a progress bar", () => {
    render(<LoadingScreen progress={0.5} stage="x" error="Boot failed" />);
    expect(screen.queryByRole("progressbar")).toBeNull();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Boot failed");
  });
});
