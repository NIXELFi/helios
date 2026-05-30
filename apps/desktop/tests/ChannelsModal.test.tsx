import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { ChannelsModal } from "../src/components/ChannelsModal";
import type { ChannelMeta } from "@helios/store";

afterEach(cleanup);

const channels: ChannelMeta[] = [
  {
    id: "engine.aps", display_name: "APS", units: "%", group: "Engine",
    color: "#fff", decimals: 1, data_type: "f64", source: "csv",
    sample_rate_hz: 100, source_header: "APS Sensor 1",
  },
  {
    id: "engine.tps", display_name: "TPS", units: "%", group: "Engine",
    color: "#fff", decimals: 1, data_type: "f64", source: "csv",
    sample_rate_hz: 100, source_header: "Throttle Position",
  },
];

const sourceHeaders = [
  { sourceHeader: "APS Sensor 1", channelId: "engine.aps", displayName: "APS" },
  { sourceHeader: "Throttle Pedal Pos", channelId: "Throttle Pedal Pos", displayName: "Throttle Pedal Pos" },
  { sourceHeader: "Throttle Position", channelId: "engine.tps", displayName: "TPS" },
];

describe("ChannelsModal — source override picker", () => {
  it("renders every channel's source_header in the Source column", () => {
    render(
      <ChannelsModal
        channels={channels}
        sessionLabel="Test"
        sourceHeaders={sourceHeaders}
        overrides={{}}
        onOverrideChange={() => {}}
        onClose={() => {}}
      />,
    );
    // Both source_header strings show up in the table.
    expect(screen.getAllByText("APS Sensor 1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Throttle Position").length).toBeGreaterThan(0);
  });

  it("clicking the source cell opens the picker with every source header + reset", () => {
    render(
      <ChannelsModal
        channels={channels}
        sessionLabel="Test"
        sourceHeaders={sourceHeaders}
        overrides={{}}
        onOverrideChange={() => {}}
        onClose={() => {}}
      />,
    );
    // The trigger for engine.aps shows "APS Sensor 1" (its auto source).
    const trigger = screen.getAllByRole("button", { name: /APS Sensor 1/ })[0]!;
    fireEvent.click(trigger);
    // After open we get a listbox.
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getByText(/Reset to auto/)).toBeInTheDocument();
    // Every source header is offered (Throttle Pedal Pos appears as a fresh
    // option not present in the row above).
    expect(screen.getAllByText("Throttle Pedal Pos").length).toBeGreaterThan(0);
  });

  it("picking a different source fires onOverrideChange with that source_header", () => {
    const onOverrideChange = vi.fn();
    render(
      <ChannelsModal
        channels={channels}
        sessionLabel="Test"
        sourceHeaders={sourceHeaders}
        overrides={{}}
        onOverrideChange={onOverrideChange}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: /APS Sensor 1/ })[0]!);
    // Pick the "Throttle Pedal Pos" option (its container is a button).
    fireEvent.click(screen.getByRole("option", { name: /Throttle Pedal Pos/ }));
    expect(onOverrideChange).toHaveBeenCalledWith("engine.aps", "Throttle Pedal Pos");
  });

  it("picking Reset to auto fires onOverrideChange(canonicalId, null)", () => {
    const onOverrideChange = vi.fn();
    render(
      <ChannelsModal
        channels={channels}
        sessionLabel="Test"
        sourceHeaders={sourceHeaders}
        overrides={{ "engine.aps": "Throttle Pedal Pos" }}
        onOverrideChange={onOverrideChange}
        onClose={() => {}}
      />,
    );
    // Trigger shows the override target now, not the auto value.
    fireEvent.click(screen.getAllByRole("button", { name: /Throttle Pedal Pos/ })[0]!);
    fireEvent.click(screen.getByRole("option", { name: /Reset to auto/ }));
    expect(onOverrideChange).toHaveBeenCalledWith("engine.aps", null);
  });

  it("the override count is shown in the header chrome", () => {
    render(
      <ChannelsModal
        channels={channels}
        sessionLabel="Test"
        sourceHeaders={sourceHeaders}
        overrides={{ "engine.aps": "Throttle Pedal Pos" }}
        onOverrideChange={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/1 overridden/)).toBeInTheDocument();
  });
});

describe("ChannelsModal — L12 empty state + keyed fragments", () => {
  it("shows an empty-state row when the filter excludes every channel", () => {
    render(
      <ChannelsModal
        channels={channels}
        sessionLabel="Test"
        sourceHeaders={sourceHeaders}
        overrides={{}}
        onOverrideChange={() => {}}
        onClose={() => {}}
      />,
    );
    const input = screen.getByPlaceholderText(/filter by id/i);
    fireEvent.change(input, { target: { value: "zzz-nothing-matches" } });
    expect(screen.getByText(/no matching channels/i)).toBeInTheDocument();
    // Count chrome reflects the empty filter.
    expect(screen.getByText(/0 \/ 2/)).toBeInTheDocument();
  });

  it("does not emit a React key warning for grouped rows", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ChannelsModal
        channels={channels}
        sessionLabel="Test"
        sourceHeaders={sourceHeaders}
        overrides={{}}
        onOverrideChange={() => {}}
        onClose={() => {}}
      />,
    );
    const keyWarning = errSpy.mock.calls.some((c) =>
      String(c[0]).includes("unique \"key\"") || String(c[0]).includes("unique key"),
    );
    expect(keyWarning).toBe(false);
    errSpy.mockRestore();
  });
});

describe("ChannelsModal — X2 modal a11y", () => {
  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <ChannelsModal
        channels={channels}
        sessionLabel="Test"
        sourceHeaders={sourceHeaders}
        overrides={{}}
        onOverrideChange={() => {}}
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
