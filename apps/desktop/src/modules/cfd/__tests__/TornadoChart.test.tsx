import { render, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { TornadoChart } from "../components/charts/TornadoChart";
import type { TornadoBar } from "../components/charts/TornadoChart";

const bars: TornadoBar[] = [
  { label: "runner_length", value: 0.82, favorable: true, n: 20 },
  { label: "plenum_volume_l", value: -0.41, favorable: false, n: 20 },
];

function noNaN(container: HTMLElement) {
  for (const r of container.querySelectorAll("rect")) {
    expect(r.getAttribute("x")).not.toContain("NaN");
    expect(r.getAttribute("width")).not.toContain("NaN");
  }
}

describe("TornadoChart", () => {
  it("renders one labeled bar per entry", () => {
    const { container, getByText } = render(<TornadoChart title="sensitivity" bars={bars} />);
    expect(getByText("runner_length")).toBeTruthy();
    expect(getByText("plenum_volume_l")).toBeTruthy();
    // value labels with explicit sign
    expect(getByText("+0.82")).toBeTruthy();
    expect(getByText("-0.41")).toBeTruthy();
    noNaN(container);
  });

  it("colors favorable bars gold and unfavorable bars red", () => {
    const { container } = render(<TornadoChart title="s" bars={bars} />);
    const fills = Array.from(container.querySelectorAll("rect")).map((r) => r.getAttribute("fill"));
    expect(fills).toContain("#FFC627"); // favorable
    expect(fills).toContain("#F0826B"); // unfavorable
  });

  it("fires onBarClick with the param label", () => {
    const onClick = vi.fn();
    const { getByText } = render(
      <TornadoChart title="s" bars={bars} onBarClick={onClick} />,
    );
    fireEvent.click(getByText("runner_length"));
    expect(onClick).toHaveBeenCalledWith("runner_length");
  });

  it("shows an empty-state message with no bars", () => {
    const { getByText, container } = render(<TornadoChart title="s" bars={[]} />);
    expect(getByText(/Not enough varied trials/)).toBeTruthy();
    expect(container.querySelector("svg")).toBeNull();
  });

  it("clamps |ρ|>1 without producing NaN widths", () => {
    const wild: TornadoBar[] = [{ label: "x", value: 1.5, favorable: true }];
    const { container } = render(<TornadoChart title="s" bars={wild} />);
    noNaN(container);
  });
});
