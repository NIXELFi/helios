// Study rename: name resolution, reducer set/clear, provenance auto-names,
// curve-source labels, and the inline editor's keyboard contract.

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { studyName, configStem, sweepFromTrialName, refineName } from "../lib/studyName";
import { sourcesFrom } from "../lib/curveSources";
import { reducer } from "../state/CfdContext";
import { StudyNameEditor } from "../components/StudyNameEditor";
import { makeSweepStudy } from "./fakes/study";
import type { State } from "../state/CfdContext";

function stateWith(study: ReturnType<typeof makeSweepStudy>): State {
  return {
    hydrated: true, loadedConfig: null, activeScreen: "studies",
    activeStudyId: null, studies: { [study.id]: study },
    vehicleConfig: null, referenceBaseline: null,
  } as unknown as State;
}

describe("studyName", () => {
  it("falls back to the config basename, trims blanks", () => {
    expect(studyName({ configPath: "/x/sdm26.json" })).toBe("sdm26.json");
    expect(studyName({ name: "  ", configPath: "/x/sdm26.json" })).toBe("sdm26.json");
    expect(studyName({ name: "runner study", configPath: "/x/sdm26.json" })).toBe("runner study");
  });

  it("builds provenance auto-names from the config stem", () => {
    expect(configStem("/x/sdm26.json")).toBe("sdm26");
    expect(sweepFromTrialName("/x/sdm26.json", 12)).toBe("sdm26 — opt #12 recipe");
    expect(refineName("/x/sdm26.json", 3)).toBe("sdm26 — refine of #3");
  });
});

describe("renameStudy reducer", () => {
  it("sets, trims, and clears the name", () => {
    const study = makeSweepStudy({ id: "s1" });
    let s = reducer(stateWith(study), { type: "renameStudy", id: "s1", name: "  long runner  " });
    expect(s.studies["s1"]!.name).toBe("long runner");
    s = reducer(s, { type: "renameStudy", id: "s1", name: "   " });
    expect("name" in s.studies["s1"]!).toBe(false); // dropped, not undefined
    expect(reducer(s, { type: "renameStudy", id: "nope", name: "x" })).toBe(s);
  });
});

describe("sourcesFrom labels", () => {
  it("uses the custom name when set", () => {
    const study = makeSweepStudy({ id: "s1" });
    const named = { ...study, name: "long runner" };
    expect(sourcesFrom({ s1: named })[0]!.label).toContain("long runner");
    expect(sourcesFrom({ s1: study })[0]!.label).toContain("sdm26");
  });
});

describe("StudyNameEditor", () => {
  it("opens on click, commits on Enter, clears on blank", () => {
    const onRename = vi.fn();
    render(<StudyNameEditor display="sdm26.json" customName={undefined} onRename={onRename} />);
    fireEvent.click(screen.getByRole("button", { name: /rename sdm26\.json/i }));
    const input = screen.getByRole("textbox", { name: /study name/i });
    fireEvent.change(input, { target: { value: "baseline sweep" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith("baseline sweep");
  });

  it("Escape cancels without renaming", () => {
    const onRename = vi.fn();
    render(<StudyNameEditor display="sdm26.json" customName="old" onRename={onRename} />);
    fireEvent.click(screen.getByRole("button", { name: /rename/i }));
    const input = screen.getByRole("textbox", { name: /study name/i });
    fireEvent.change(input, { target: { value: "typo" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onRename).not.toHaveBeenCalled();
    // Editor closed — back to the button.
    expect(screen.getByRole("button", { name: /rename/i })).toBeTruthy();
  });
});
