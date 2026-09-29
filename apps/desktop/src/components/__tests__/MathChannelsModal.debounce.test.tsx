/** Math-channel editor must not commit (and so re-evaluate every math channel
 *  on every session) per keystroke: edits debounce, and flush on blur/close. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MathChannelsModal, MATH_COMMIT_DEBOUNCE_MS } from "../MathChannelsModal";
import type { MathChannel } from "../../lib/math-channels";

const CH: MathChannel = {
  id: "math.a", display_name: "A", units: "", decimals: 2, color: "#FFC627",
  group: "Math", expression: "1",
};

function setup() {
  const onChange = vi.fn();
  const utils = render(
    <MathChannelsModal
      channels={[CH]}
      errors={new Map()}
      availableChannels={[]}
      onChange={onChange}
      onClose={vi.fn()}
    />,
  );
  const ta = screen.getByPlaceholderText(/derivative/) as HTMLTextAreaElement;
  return { onChange, ta, ...utils };
}

describe("MathChannelsModal commit debounce", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("coalesces a burst of keystrokes into one commit", () => {
    const { onChange, ta } = setup();
    for (const v of ["1+", "1+2", "1+23", "1+234"]) fireEvent.change(ta, { target: { value: v } });
    expect(ta.value).toBe("1+234"); // the draft updates immediately
    expect(onChange).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(MATH_COMMIT_DEBOUNCE_MS); });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0][0].expression).toBe("1+234");
  });

  it("flushes the pending edit on blur", () => {
    const { onChange, ta } = setup();
    fireEvent.change(ta, { target: { value: "2" } });
    fireEvent.blur(ta);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0][0].expression).toBe("2");
    act(() => { vi.advanceTimersByTime(MATH_COMMIT_DEBOUNCE_MS * 2); });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("flushes the pending edit when the modal closes (unmount)", () => {
    const { onChange, ta, unmount } = setup();
    fireEvent.change(ta, { target: { value: "3" } });
    unmount();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0][0].expression).toBe("3");
  });
});
