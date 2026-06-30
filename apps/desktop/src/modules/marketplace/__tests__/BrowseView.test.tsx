import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BrowseView } from "../views/BrowseView";
import { makePlugin } from "./_fixtures";

afterEach(cleanup);

const noop = () => {};

function renderBrowse(plugins = [makePlugin()], props = {}) {
  return render(
    <BrowseView
      plugins={plugins}
      loading={false}
      error={null}
      onOpenDetail={noop}
      onRequestInstall={noop}
      onOpen={noop}
      {...props}
    />,
  );
}

describe("BrowseView", () => {
  it("offers Install for an uninstalled add-on and Open for an installed one", () => {
    renderBrowse([
      makePlugin({ id: "a", name: "Alpha", installedVersion: null }),
      makePlugin({ id: "b", name: "Bravo", installedVersion: "1.0.0", version: "1.0.0" }),
    ]);
    expect(screen.getByRole("button", { name: /^install$/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^open$/i })).toBeTruthy();
  });

  it("surfaces an Update action when a newer approved version exists", () => {
    renderBrowse([makePlugin({ installedVersion: "1.0.0", version: "1.2.0" })]);
    expect(screen.getByRole("button", { name: /update to v1\.2\.0/i })).toBeTruthy();
  });

  it("sorts recommended add-ons first regardless of name", () => {
    renderBrowse([
      makePlugin({ id: "a", name: "Alpha", isRecommended: false }),
      makePlugin({ id: "z", name: "Zebra", isRecommended: true }),
    ]);
    const cards = screen.getAllByRole("button", { name: /details for/i });
    expect(cards[0]?.getAttribute("aria-label")).toMatch(/Zebra/);
  });

  it("filters by the search query", () => {
    renderBrowse([
      makePlugin({ id: "a", name: "Aero Tool" }),
      makePlugin({ id: "b", name: "Chassis Tool" }),
    ]);
    fireEvent.change(screen.getByLabelText(/search add-ons/i), { target: { value: "chassis" } });
    expect(screen.queryByText("Aero Tool")).toBeNull();
    expect(screen.getByText("Chassis Tool")).toBeTruthy();
  });

  it("routes Install clicks to onRequestInstall (consent is the container's job)", () => {
    const onRequestInstall = vi.fn();
    renderBrowse([makePlugin({ installedVersion: null })], { onRequestInstall });
    fireEvent.click(screen.getByRole("button", { name: /^install$/i }));
    expect(onRequestInstall).toHaveBeenCalledTimes(1);
  });

  it("shows an empty-state message when nothing is available", () => {
    renderBrowse([]);
    expect(screen.getByText(/no add-ons are available/i)).toBeTruthy();
  });
});
