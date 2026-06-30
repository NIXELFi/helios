import type { ComponentProps } from "react";
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PluginDetail } from "../views/PluginDetail";
import { makePlugin } from "./_fixtures";

afterEach(cleanup);

const noop = () => {};

function renderDetail(
  plugin: ComponentProps<typeof PluginDetail>["plugin"],
  props: Partial<ComponentProps<typeof PluginDetail>> = {},
) {
  return render(
    <PluginDetail
      plugin={plugin}
      busy={false}
      onBack={noop}
      onRequestInstall={noop}
      onUpdate={noop}
      onOpen={noop}
      onUninstall={noop}
      {...props}
    />,
  );
}

describe("PluginDetail", () => {
  it("shows name, subteam, description, permissions and version", () => {
    renderDetail(makePlugin({ subteam: "Aero", permissions: ["storage"] }));
    expect(screen.getByText("Downforce Calculator")).toBeTruthy();
    expect(screen.getByText("Aero")).toBeTruthy();
    expect(screen.getByText(/computes downforce/i)).toBeTruthy();
    expect(screen.getByText("storage")).toBeTruthy();
    expect(screen.getByText(/v1\.0\.0/)).toBeTruthy();
  });

  it("offers Install (routed to consent) when not installed", () => {
    const onRequestInstall = vi.fn();
    renderDetail(makePlugin({ installedVersion: null }), { onRequestInstall });
    fireEvent.click(screen.getByRole("button", { name: /^install$/i }));
    expect(onRequestInstall).toHaveBeenCalledTimes(1);
  });

  it("offers Open + Uninstall when installed", () => {
    const onOpen = vi.fn();
    const onUninstall = vi.fn();
    renderDetail(makePlugin({ installedVersion: "1.0.0", version: "1.0.0" }), { onOpen, onUninstall });
    fireEvent.click(screen.getByRole("button", { name: /^open$/i }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /uninstall/i }));
    expect(onUninstall).toHaveBeenCalledTimes(1);
  });
});
