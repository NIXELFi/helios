import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { CONNECTION_GRACE_MS, ConnectionChip } from "../src/components/ConnectionChip";
import { _resetConnectionState, publishConnectionState } from "../src/lib/connection-status";

beforeEach(() => {
  _resetConnectionState();
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("<ConnectionChip>", () => {
  it("stays hidden on a cold start and while the link is up", () => {
    const { container } = render(<ConnectionChip />);
    expect(container).toBeEmptyDOMElement();
    act(() => publishConnectionState("up"));
    act(() => { vi.advanceTimersByTime(CONNECTION_GRACE_MS * 2); });
    expect(container).toBeEmptyDOMElement();
  });

  it("appears only after the link has been down for the grace period, then clears on recovery", () => {
    const { container } = render(<ConnectionChip />);
    act(() => publishConnectionState("up"));
    act(() => publishConnectionState("down"));
    act(() => { vi.advanceTimersByTime(CONNECTION_GRACE_MS - 100); });
    expect(container).toBeEmptyDOMElement(); // a blip inside the window never shows
    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.getByRole("status", { name: /Reconnecting/ })).toBeInTheDocument();
    act(() => publishConnectionState("up"));
    expect(container).toBeEmptyDOMElement();
  });
});
