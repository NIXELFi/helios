import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { CommitDateInput } from "../CommitDateInput";

afterEach(cleanup);

function setup(value: string | null = "2026-07-25") {
  const onCommit = vi.fn();
  const { container } = render(
    <CommitDateInput value={value} onCommit={onCommit} aria-label="date" />,
  );
  return { input: container.querySelector("input")!, onCommit };
}

describe("CommitDateInput", () => {
  it("does not save the partial years a date input emits while typing", () => {
    const { input, onCommit } = setup();
    for (const v of ["0002-08-18", "0020-08-18", "0202-08-18"]) {
      fireEvent.change(input, { target: { value: v } });
    }
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "2025-08-18" } });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("2025-08-18");
  });

  it("drops an unfinished year on blur and shows the saved date again", () => {
    const { input, onCommit } = setup();
    fireEvent.change(input, { target: { value: "0202-08-18" } });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe("2026-07-25");
  });

  it("saves a clear as null", () => {
    const { input, onCommit } = setup();
    fireEvent.change(input, { target: { value: "" } });
    expect(onCommit).toHaveBeenCalledWith(null);
  });
});
