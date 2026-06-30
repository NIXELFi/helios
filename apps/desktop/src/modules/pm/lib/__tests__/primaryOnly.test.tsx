import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { recallPrimaryOnly, rememberPrimaryOnly, usePrimaryOnly } from "../primaryOnly";

const KEY = "helios:pmPrimaryOnly";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});
beforeEach(() => {
  window.localStorage.clear();
});

describe("primaryOnly persistence", () => {
  it("round-trips the flag through localStorage", () => {
    expect(recallPrimaryOnly()).toBe(false); // missing key
    rememberPrimaryOnly(true);
    expect(window.localStorage.getItem(KEY)).toBe("1");
    expect(recallPrimaryOnly()).toBe(true);
    rememberPrimaryOnly(false);
    expect(window.localStorage.getItem(KEY)).toBe("0");
    expect(recallPrimaryOnly()).toBe(false);
  });

  it("returns false (never throws) when storage reads fail", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => recallPrimaryOnly()).not.toThrow();
    expect(recallPrimaryOnly()).toBe(false);
  });

  it("swallows storage write failures", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => rememberPrimaryOnly(true)).not.toThrow();
  });
});

// Two consumers of usePrimaryOnly in the same tree must agree: toggling in one
// re-renders the other. This cross-instance sync is the load-bearing contract
// that lets a toggle in one view's filter bar drive the scope computation that
// reads the flag elsewhere.
function Consumer({ id }: { id: string }) {
  const [value, setValue] = usePrimaryOnly();
  return (
    <div>
      <span data-testid={`${id}-val`}>{value ? "on" : "off"}</span>
      <button data-testid={`${id}-toggle`} onClick={() => setValue(!value)}>
        toggle {id}
      </button>
    </div>
  );
}

describe("usePrimaryOnly cross-instance sync", () => {
  it("propagates a toggle to every mounted consumer and persists it", () => {
    render(
      <>
        <Consumer id="a" />
        <Consumer id="b" />
      </>,
    );
    expect(screen.getByTestId("a-val").textContent).toBe("off");
    expect(screen.getByTestId("b-val").textContent).toBe("off");

    fireEvent.click(screen.getByTestId("a-toggle"));

    expect(screen.getByTestId("a-val").textContent).toBe("on");
    expect(screen.getByTestId("b-val").textContent).toBe("on"); // synced from A
    expect(window.localStorage.getItem(KEY)).toBe("1"); // persisted
  });

  it("initializes from the persisted value on mount", () => {
    rememberPrimaryOnly(true);
    render(<Consumer id="a" />);
    expect(screen.getByTestId("a-val").textContent).toBe("on");
  });
});
