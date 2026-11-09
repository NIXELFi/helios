import { useCallback, useEffect, useReducer } from "react";
import type { FolderId } from "./types";

/**
 * Back/forward history for the Vault browse view, like File Explorer.
 *
 * `null` is the vault root (a real place, not "nothing selected"), so it is a
 * valid history entry like any folder.
 */
export interface FolderHistoryState {
  back: (FolderId | null)[];
  current: FolderId | null;
  forward: (FolderId | null)[];
}

export type FolderHistoryAction =
  | { type: "navigate"; id: FolderId | null }
  | { type: "back"; isLive: (id: FolderId | null) => boolean }
  | { type: "forward"; isLive: (id: FolderId | null) => boolean }
  | { type: "reset" };

/** Long sessions shouldn't grow the stack forever. */
export const FOLDER_HISTORY_LIMIT = 100;

export const EMPTY_FOLDER_HISTORY: FolderHistoryState = { back: [], current: null, forward: [] };

export function folderHistoryReducer(
  state: FolderHistoryState,
  action: FolderHistoryAction,
): FolderHistoryState {
  switch (action.type) {
    case "navigate": {
      if (action.id === state.current) return state;
      const back = [...state.back, state.current].slice(-FOLDER_HISTORY_LIMIT);
      return { back, current: action.id, forward: [] };
    }
    case "back":
    case "forward": {
      const from = action.type === "back" ? state.back : state.forward;
      // Step over entries for folders deleted since they were visited, and
      // over entries equal to where we already are (left behind by skipping).
      let i = from.length - 1;
      while (i >= 0 && (!action.isLive(from[i] as FolderId | null) || from[i] === state.current)) i--;
      if (i < 0) return state;
      const target = from[i] as FolderId | null;
      const remaining = from.slice(0, i);
      return action.type === "back"
        ? { back: remaining, current: target, forward: [...state.forward, state.current] }
        : { back: [...state.back, state.current], current: target, forward: remaining };
    }
    case "reset":
      return EMPTY_FOLDER_HISTORY;
  }
}

/** Mouse "XButton1"/"XButton2" — the thumb buttons on most mice. */
const MOUSE_BACK = 3;
const MOUSE_FORWARD = 4;

/**
 * Folder navigation with history. Thumb buttons and Alt+←/Alt+→ go back and
 * forward while `isVisible()` says the browse view is on screen: the shell keeps
 * modules mounted (just hidden) when you switch away, so mounted ≠ showing.
 * `liveFolderIds` lets back/forward skip folders that were deleted after being
 * visited; pass undefined while folders are loading.
 */
export function useFolderHistory(opts: {
  isVisible: () => boolean;
  liveFolderIds: ReadonlySet<string> | undefined;
}) {
  const { isVisible, liveFolderIds } = opts;
  const [state, dispatch] = useReducer(folderHistoryReducer, EMPTY_FOLDER_HISTORY);

  const isLive = useCallback(
    (id: FolderId | null) => id === null || !liveFolderIds || liveFolderIds.has(id),
    [liveFolderIds],
  );

  const navigate = useCallback((id: FolderId | null) => dispatch({ type: "navigate", id }), []);
  const goBack = useCallback(() => dispatch({ type: "back", isLive }), [isLive]);
  const goForward = useCallback(() => dispatch({ type: "forward", isLive }), [isLive]);
  const reset = useCallback(() => dispatch({ type: "reset" }), []);

  useEffect(() => {
    // mousedown AND mouseup are both cancelled: WebView2/Chromium treat the
    // thumb buttons as browser history navigation, which in this single-page
    // app would do nothing useful at best.
    const swallow = (e: MouseEvent) => {
      if ((e.button === MOUSE_BACK || e.button === MOUSE_FORWARD) && isVisible()) e.preventDefault();
    };
    const onMouseUp = (e: MouseEvent) => {
      if (!isVisible()) return;
      if (e.button === MOUSE_BACK) { e.preventDefault(); goBack(); }
      else if (e.button === MOUSE_FORWARD) { e.preventDefault(); goForward(); }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (!isVisible()) return;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const t = e.target as HTMLElement | null;
      // Alt+arrows inside a text field belong to the field.
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      if (e.key === "ArrowLeft") goBack(); else goForward();
    };
    window.addEventListener("mousedown", swallow);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", swallow);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isVisible, goBack, goForward]);

  const canGoBack = state.back.some((id) => isLive(id) && id !== state.current);
  const canGoForward = state.forward.some((id) => isLive(id) && id !== state.current);

  return { current: state.current, navigate, goBack, goForward, reset, canGoBack, canGoForward };
}
