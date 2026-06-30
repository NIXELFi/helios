import type { ComponentProps } from "react";
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { InstalledView } from "../views/InstalledView";
import { makePlugin } from "./_fixtures";

afterEach(cleanup);

const noop = () => {};

function renderInstalled(
  plugins: ComponentProps<typeof InstalledView>["plugins"],
  props: Partial<ComponentProps<typeof InstalledView>> = {},
) {
  return render(
    <InstalledView
      plugins={plugins}
      loading={false}
      error={null}
      busyId={null}
      onOpen={noop}
      onUpdate={noop}
      onUninstall={noop}
      onOpenDetail={noop}
      {...props}
    />,
  );
}

describe("InstalledView", () => {
  it("shows an Update affordance only when a newer version is approved", () => {
    renderInstalled([makePlugin({ installedVersion: "1.0.0", version: "1.1.0" })]);
    expect(screen.getByRole("button", { name: /update/i })).toBeTruthy();
    expect(screen.getByText(/v1\.1\.0 available/i)).toBeTruthy();
  });

  it("has no Update affordance when up to date", () => {
    renderInstalled([makePlugin({ installedVersion: "1.0.0", version: "1.0.0" })]);
    expect(screen.queryByRole("button", { name: /update/i })).toBeNull();
  });

  it("launches via onOpen and removes via onUninstall", () => {
    const onOpen = vi.fn();
    const onUninstall = vi.fn();
    const plugin = makePlugin({ installedVersion: "1.0.0", version: "1.0.0" });
    renderInstalled([plugin], { onOpen, onUninstall });
    fireEvent.click(screen.getByRole("button", { name: /^open$/i }));
    expect(onOpen).toHaveBeenCalledWith(plugin);
    fireEvent.click(screen.getByRole("button", { name: /uninstall/i }));
    expect(onUninstall).toHaveBeenCalledWith(plugin);
  });

  it("disables the row actions while it is busy", () => {
    renderInstalled([makePlugin({ id: "x", installedVersion: "1.0.0", version: "1.0.0" })], {
      busyId: "x",
    });
    expect((screen.getByRole("button", { name: /^open$/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows an empty-state pointing at Browse", () => {
    renderInstalled([]);
    expect(screen.getByText(/haven’t installed any add-ons/i)).toBeTruthy();
  });
});
