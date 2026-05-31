import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, within } from "@testing-library/react";
import { MathChannelsModal } from "../src/components/MathChannelsModal";
import type { MathChannel } from "../src/lib/math-channels";
import type { ChannelMeta } from "@helios/store";

afterEach(cleanup);

const meta = (id: string, group = "Engine"): ChannelMeta => ({
  id, display_name: id, units: "", group, color: "#fff",
  decimals: 2, data_type: "f64", source: "csv", sample_rate_hz: 100,
  source_header: id,
});

const mc = (overrides: Partial<MathChannel> = {}): MathChannel => ({
  id: "math.power", display_name: "Power", units: "kW", decimals: 2,
  color: "#FFC627", group: "Math", expression: "engine.rpm / 100",
  ...overrides,
});

const available: ChannelMeta[] = [meta("engine.rpm"), meta("imu.lat_g", "IMU")];

function renderModal(channels: MathChannel[], onChange = vi.fn(), onClose = vi.fn()) {
  render(
    <MathChannelsModal
      channels={channels}
      errors={new Map()}
      availableChannels={available}
      onChange={onChange}
      onClose={onClose}
    />,
  );
  return { onChange, onClose };
}

/** The id field is the first <input> in the editor pane. */
function idInput(): HTMLInputElement {
  return screen.getByDisplayValue("math.power") as HTMLInputElement;
}

describe("MathChannelsModal — C4 id collision guard", () => {
  it("rejects an id that duplicates another math channel's id", () => {
    const channels = [mc({ id: "math.power" }), mc({ id: "math.other", display_name: "Other" })];
    const { onChange } = renderModal(channels);
    // Editing the first channel's id to collide with the second.
    fireEvent.change(idInput(), { target: { value: "math.other" } });
    // An inline error must surface…
    expect(screen.getByText(/already (used|in use|exists)|duplicate|collid/i)).toBeInTheDocument();
    // …and the colliding id must NOT be committed to the parent.
    for (const call of onChange.mock.calls) {
      const next = call[0] as MathChannel[];
      const ids = next.map((c) => c.id);
      // No duplicate ids ever propagated.
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("warns when an id shadows an existing source channel id", () => {
    const channels = [mc({ id: "math.power" })];
    const { onChange } = renderModal(channels);
    fireEvent.change(idInput(), { target: { value: "engine.rpm" } });
    // Shadow warning shown.
    expect(screen.getByText(/shadow|already|source channel|exists/i)).toBeInTheDocument();
    // The shadowing id must not be committed (would overwrite a real logged channel).
    for (const call of onChange.mock.calls) {
      const next = call[0] as MathChannel[];
      expect(next.some((c) => c.id === "engine.rpm")).toBe(false);
    }
  });

  it("accepts a unique non-shadowing id and commits it", () => {
    const channels = [mc({ id: "math.power" })];
    const { onChange } = renderModal(channels);
    fireEvent.change(idInput(), { target: { value: "math.torque" } });
    const committed = onChange.mock.calls.some((call) =>
      (call[0] as MathChannel[]).some((c) => c.id === "math.torque"),
    );
    expect(committed).toBe(true);
  });
});

describe("MathChannelsModal — L11 decimals clamp", () => {
  function decimalsInput(): HTMLInputElement {
    // The decimals field is the only number input near the "decimals" label
    // with min=0/max=6 in the metadata grid.
    return screen.getAllByRole("spinbutton").find(
      (el) => (el as HTMLInputElement).max === "6",
    ) as HTMLInputElement;
  }

  it("clamps values above 6 down to 6", () => {
    const { onChange } = renderModal([mc({ decimals: 2 })]);
    fireEvent.change(decimalsInput(), { target: { value: "50" } });
    const last = onChange.mock.calls.at(-1)![0] as MathChannel[];
    expect(last[0]!.decimals).toBe(6);
  });

  it("clamps negative values up to 0", () => {
    const { onChange } = renderModal([mc({ decimals: 2 })]);
    fireEvent.change(decimalsInput(), { target: { value: "-3" } });
    const last = onChange.mock.calls.at(-1)![0] as MathChannel[];
    expect(last[0]!.decimals).toBe(0);
  });

  it("coerces empty / non-numeric input to 0", () => {
    const { onChange } = renderModal([mc({ decimals: 2 })]);
    fireEvent.change(decimalsInput(), { target: { value: "" } });
    const last = onChange.mock.calls.at(-1)![0] as MathChannel[];
    expect(last[0]!.decimals).toBe(0);
  });

  it("rounds fractional input to an integer", () => {
    const { onChange } = renderModal([mc({ decimals: 2 })]);
    fireEvent.change(decimalsInput(), { target: { value: "2.7" } });
    const last = onChange.mock.calls.at(-1)![0] as MathChannel[];
    expect(last[0]!.decimals).toBe(3);
  });
});

describe("MathChannelsModal — X2 modal a11y", () => {
  it("closes on Escape", () => {
    const { onClose } = renderModal([mc()]);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("MathChannelsModal — X3 in-app delete confirm", () => {
  it("does not call window.confirm and shows an in-app confirm dialog instead", () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    const channels = [mc({ id: "math.power" })];
    const { onChange } = renderModal(channels);
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    // Native confirm must not be used.
    expect(confirmSpy).not.toHaveBeenCalled();
    // An in-app confirm dialog appears asking to confirm deletion.
    const dialogs = screen.getAllByRole("dialog");
    const confirmDialog = dialogs.find((d) => within(d).queryAllByText(/delete math channel/i).length > 0);
    expect(confirmDialog).toBeTruthy();
    // Channel is not removed until the user confirms.
    expect(onChange).not.toHaveBeenCalled();
    // Confirm it.
    const confirmBtn = within(confirmDialog!).getAllByRole("button", { name: /delete/i }).at(-1)!;
    fireEvent.click(confirmBtn);
    const removed = onChange.mock.calls.some((call) =>
      (call[0] as MathChannel[]).length === 0,
    );
    expect(removed).toBe(true);
    confirmSpy.mockRestore();
  });
});
