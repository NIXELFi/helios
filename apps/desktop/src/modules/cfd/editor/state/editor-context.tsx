// Wraps the editor reducer with React + bridge wiring. The Save flow
// resolves through the native save dialog when needed, then through
// cfd_save_config (which validates via engine-sim before writing).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import { save as openSaveDialog } from "@tauri-apps/plugin-dialog";

import { useCfd } from "../../state/CfdContext";
import {
  editorReducer,
  initialEditorState,
  isDirty,
  hasFieldErrors,
  canSave as canSaveSelector,
  type EditorAction,
  type EditorState,
} from "./editor-actions";

interface EditorContextValue {
  state: EditorState;
  dispatch: (action: EditorAction) => void;
  isDirty: boolean;
  hasFieldErrors: boolean;
  canSave: boolean;
  /// Save to the current path. Falls through to Save-As when no path,
  /// or when the loaded config is a bundled example.
  save: () => Promise<void>;
  saveAs: () => Promise<void>;
  discard: () => void;
}

const EditorCtx = createContext<EditorContextValue | null>(null);

export function useEditor(): EditorContextValue {
  const v = useContext(EditorCtx);
  if (!v) throw new Error("useEditor must be used inside <EditorProvider>");
  return v;
}

interface ProviderProps {
  children: ReactNode;
}

export function EditorProvider({ children }: ProviderProps) {
  const { state: cfdState, bridge, setLoadedConfig } = useCfd();
  const [state, dispatch] = useReducer(editorReducer, initialEditorState);
  const stateRef = useRef(state);
  stateRef.current = state;

  // When CfdContext's loadedConfig changes (Open / Load example), reset
  // the editor to track it.
  const loadedRef = useRef<string | null>(null);
  useEffect(() => {
    const lc = cfdState.loadedConfig;
    if (!lc) {
      if (loadedRef.current !== null) {
        loadedRef.current = null;
        dispatch({ type: "reset" });
      }
      return;
    }
    // Avoid resetting when the same config is re-emitted post-save.
    const tag = `${lc.path}::${lc.isExample}`;
    if (tag === loadedRef.current && !isDirty(stateRef.current)) {
      return;
    }
    loadedRef.current = tag;
    dispatch({
      type: "loadFromConfig",
      path: lc.path,
      raw: lc.raw,
      isExample: lc.isExample,
    });
  }, [cfdState.loadedConfig]);

  const doSave = useCallback(
    async (forceSaveAs: boolean) => {
      const cur = stateRef.current;
      if (!isDirty(cur)) return;
      if (hasFieldErrors(cur)) {
        return; // UI blocks save; this is defensive.
      }
      let path = cur.savedPath;
      const needsDialog = forceSaveAs || !path || cur.isExample;
      if (needsDialog) {
        const defaultDir = await bridge.defaultSaveDir().catch(() => null);
        const suggested =
          path && !cur.isExample
            ? path
            : (defaultDir
                ? `${defaultDir.replace(/[/\\]$/, "")}/new-config.json`
                : "new-config.json");
        const picked = await openSaveDialog({
          defaultPath: suggested,
          filters: [{ name: "Engine config", extensions: ["json"] }],
        });
        if (typeof picked !== "string" || picked.trim() === "") return;
        path = picked;
      }
      try {
        await bridge.saveConfig(path!, cur.draft);
        dispatch({ type: "saveSucceeded", path: path!, isExample: false });
        // Push the saved state back into the CfdContext so the rest of
        // the app (Studies screen path label, etc.) sees the new path.
        const updatedSummary = cfdState.loadedConfig?.summary ?? {
          displayName: "",
          nCylinders: 0,
          boreMm: 0,
          strokeMm: 0,
          compressionRatio: 0,
          displacementL: 0,
          restrictorThroatMm: 0,
          plenumVolumeL: 0,
        };
        setLoadedConfig({
          path: path!,
          raw: cur.draft,
          summary: updatedSummary,
          isExample: false,
        });
      } catch (e) {
        dispatch({
          type: "setGlobalError",
          message: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [bridge, cfdState.loadedConfig, setLoadedConfig],
  );

  const value = useMemo<EditorContextValue>(() => ({
    state,
    dispatch,
    isDirty: isDirty(state),
    hasFieldErrors: hasFieldErrors(state),
    canSave: canSaveSelector(state),
    save: () => doSave(false),
    saveAs: () => doSave(true),
    discard: () => dispatch({ type: "discardChanges" }),
  }), [state, doSave]);

  return <EditorCtx.Provider value={value}>{children}</EditorCtx.Provider>;
}
