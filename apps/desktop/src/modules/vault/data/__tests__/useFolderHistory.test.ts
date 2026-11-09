import { describe, expect, it } from "vitest";
import {
  EMPTY_FOLDER_HISTORY,
  FOLDER_HISTORY_LIMIT,
  folderHistoryReducer as r,
  type FolderHistoryState,
} from "../useFolderHistory";
import type { FolderId } from "../types";

const f = (s: string) => s as FolderId;
const all = () => true;

function walk(...ids: (string | null)[]): FolderHistoryState {
  return ids.reduce<FolderHistoryState>(
    (s, id) => r(s, { type: "navigate", id: id === null ? null : f(id) }),
    EMPTY_FOLDER_HISTORY,
  );
}

describe("folderHistoryReducer", () => {
  it("navigates, goes back and forward like Explorer", () => {
    let s = walk("a", "b", "c");
    expect(s.current).toBe("c");
    s = r(s, { type: "back", isLive: all });
    expect(s.current).toBe("b");
    s = r(s, { type: "back", isLive: all });
    expect(s.current).toBe("a");
    s = r(s, { type: "back", isLive: all });
    expect(s.current).toBe(null); // the vault root is a real stop
    expect(r(s, { type: "back", isLive: all })).toBe(s); // nothing further back
    s = r(s, { type: "forward", isLive: all });
    s = r(s, { type: "forward", isLive: all });
    expect(s.current).toBe("b");
  });

  it("navigating after going back drops the forward stack", () => {
    let s = walk("a", "b", "c");
    s = r(s, { type: "back", isLive: all });
    s = r(s, { type: "navigate", id: f("x") });
    expect(s.forward).toEqual([]);
    expect(r(s, { type: "forward", isLive: all })).toBe(s);
    s = r(s, { type: "back", isLive: all });
    expect(s.current).toBe("b");
  });

  it("re-selecting the current folder adds no entry", () => {
    const s = walk("a");
    expect(r(s, { type: "navigate", id: f("a") })).toBe(s);
  });

  it("skips folders deleted since they were visited", () => {
    let s = walk("a", "gone", "c");
    s = r(s, { type: "back", isLive: (id) => id !== "gone" });
    expect(s.current).toBe("a");
    s = r(s, { type: "forward", isLive: (id) => id !== "gone" });
    expect(s.current).toBe("c");
  });

  it("caps the back stack", () => {
    const ids = Array.from({ length: FOLDER_HISTORY_LIMIT + 50 }, (_, i) => `f${i}`);
    const s = walk(...ids);
    expect(s.back.length).toBe(FOLDER_HISTORY_LIMIT);
  });

  it("reset clears everything", () => {
    expect(r(walk("a", "b"), { type: "reset" })).toEqual(EMPTY_FOLDER_HISTORY);
  });
});
