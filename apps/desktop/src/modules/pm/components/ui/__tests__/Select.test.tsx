import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { Select, type SelectOption } from "../Select";

// The owner pickers (create dialog, detail sheet, co-owner chips) derive their
// options from the store's tasks slice, so a background hydrate or realtime
// tick while the menu is open hands Select a NEW options array with the same
// content. Bug-bash 0831 review: the on-open effect was keyed on that array's
// identity, so every tick wiped the typed search and reset the highlight to
// the first person — and the next Enter added whoever that was (a real
// task_owners INSERT). These pin the menu to `open` alone.

const PEOPLE: SelectOption<string>[] = [
  { value: "a", label: "Alex Rumer", group: "DAQ · this subteam" },
  { value: "b", label: "Bo Nguyen", group: "DAQ · this subteam" },
  { value: "c", label: "Cy Patel", group: "Everyone else" },
  { value: "d", label: "Dee Park", group: "Everyone else" },
  { value: "e", label: "Eli Stone", group: "Everyone else" },
  { value: "f", label: "Fay Ortiz", group: "Everyone else" },
  { value: "g", label: "Gus Lee", group: "Everyone else" },
  { value: "h", label: "Hal Ives", group: "Everyone else" },
  { value: "i", label: "Ivy Quinn", group: "Everyone else" },
];

afterEach(cleanup);

function headings(): string[] {
  return Array.from(document.querySelectorAll('[role="listbox"] span[aria-hidden]'))
    .map((n) => n.textContent ?? "")
    .filter((t) => t !== "");
}

describe("Select — options identity while open", () => {
  test("a new options array with the same content keeps the typed search and highlight", () => {
    const { rerender } = render(
      <Select value="" onChange={() => {}} ariaLabel="Owner" options={PEOPLE} searchable />,
    );
    fireEvent.click(screen.getByLabelText("Owner"));
    const search = screen.getByLabelText("Filter options") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "quinn" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Ivy Quinn"]);

    // A store tick: same people, fresh array.
    rerender(
      <Select value="" onChange={() => {}} ariaLabel="Owner" options={PEOPLE.map((p) => ({ ...p }))} searchable />,
    );

    expect(search.value).toBe("quinn");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Ivy Quinn"]);
  });

  test("Enter after a store tick commits the person you searched for, not the first in the list", () => {
    const picked: string[] = [];
    const { rerender } = render(
      <Select value="" onChange={(v) => picked.push(v)} ariaLabel="Owner" options={PEOPLE} searchable />,
    );
    fireEvent.click(screen.getByLabelText("Owner"));
    const search = screen.getByLabelText("Filter options");
    fireEvent.change(search, { target: { value: "quinn" } });
    rerender(
      <Select value="" onChange={(v) => picked.push(v)} ariaLabel="Owner" options={PEOPLE.map((p) => ({ ...p }))} searchable />,
    );
    fireEvent.keyDown(search, { key: "Enter" });
    expect(picked).toEqual(["i"]);
  });
});

describe("Select — group headings", () => {
  test("shows one heading per group when two groups are visible", () => {
    render(<Select value="" onChange={() => {}} ariaLabel="Owner" options={PEOPLE} />);
    fireEvent.click(screen.getByLabelText("Owner"));
    expect(headings()).toEqual(["DAQ · this subteam", "Everyone else"]);
  });

  test("shows no heading at all when only one group is left on screen", () => {
    // A DAQ task whose only DAQ-attributed member is already the primary owner
    // leaves the co-owner picker with nothing but "Everyone else" — a lone
    // heading over the whole list told the user the subteam bucket was missing.
    const onlyOthers = PEOPLE.filter((p) => p.group === "Everyone else");
    render(<Select value="" onChange={() => {}} ariaLabel="Owner" options={onlyOthers} />);
    fireEvent.click(screen.getByLabelText("Owner"));
    expect(headings()).toEqual([]);
  });

  test("a search that narrows to one group drops the headings too", () => {
    render(<Select value="" onChange={() => {}} ariaLabel="Owner" options={PEOPLE} searchable />);
    fireEvent.click(screen.getByLabelText("Owner"));
    fireEvent.change(screen.getByLabelText("Filter options"), { target: { value: "cy" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Cy Patel"]);
    expect(headings()).toEqual([]);
  });
});
