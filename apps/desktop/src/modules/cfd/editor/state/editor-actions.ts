// Editor reducer + state. Pure — no side effects, no Tauri calls.
// editor-context.tsx wraps this with React + Tauri I/O.

import {
  DEFAULT_INTAKE_PIPE,
  DEFAULT_PRIMARY_PIPE,
  DEFAULT_SECONDARY_PIPE,
  SDM26_SCHEMA,
  deriveTopology,
  type FieldMeta,
  type Topology,
} from "../../lib/sdm26Schema";
import { getAt, setAt } from "../lib/path-helpers";
import { deepEqual } from "../lib/deep-equal";
import { validateAll, validateField } from "../validation/client-rules";

export interface EditorState {
  draft: Record<string, unknown>;
  savedSnapshot: Record<string, unknown>;
  savedPath: string | null;
  isExample: boolean;
  fieldErrors: Record<string, string>;
  globalError: string | null;
  diffOpen: boolean;
  templatePickerOpen: boolean;
}

export const initialEditorState: EditorState = {
  draft: {},
  savedSnapshot: {},
  savedPath: null,
  isExample: false,
  fieldErrors: {},
  globalError: null,
  diffOpen: false,
  templatePickerOpen: false,
};

export type EditorAction =
  | { type: "loadFromConfig"; path: string; raw: Record<string, unknown>; isExample: boolean }
  | { type: "loadTemplate"; raw: Record<string, unknown> }
  | { type: "reset" }
  | { type: "setField"; path: string; value: unknown }
  | { type: "addPipeRow"; pipesKey: PipesKey }
  | { type: "removePipeRow"; pipesKey: PipesKey; index: number }
  | { type: "duplicatePipeRow"; pipesKey: PipesKey; index: number }
  | { type: "setPipeRow"; pipesKey: PipesKey; index: number; row: Record<string, unknown> }
  | { type: "setCdTable"; valveKey: "intake_valve" | "exhaust_valve"; table: Array<[number, number]> }
  | { type: "changeTopology"; topology: Topology }
  | { type: "saveSucceeded"; path: string; isExample: boolean }
  | { type: "setGlobalError"; message: string | null }
  | { type: "discardChanges" }
  | { type: "openDiff" }
  | { type: "closeDiff" }
  | { type: "openTemplatePicker" }
  | { type: "closeTemplatePicker" };

export type PipesKey = "intake_pipes" | "exhaust_primaries" | "exhaust_secondaries";

function pipeDefault(pipesKey: PipesKey): Record<string, unknown> {
  switch (pipesKey) {
    case "intake_pipes": return { ...DEFAULT_INTAKE_PIPE };
    case "exhaust_primaries": return { ...DEFAULT_PRIMARY_PIPE };
    case "exhaust_secondaries": return { ...DEFAULT_SECONDARY_PIPE };
  }
}

function getPipes(state: EditorState, key: PipesKey): Array<Record<string, unknown>> {
  const v = state.draft[key];
  return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
}

function recomputeFieldErrors(
  draft: Record<string, unknown>,
  prev: Record<string, string>,
  changedPath?: string,
): Record<string, string> {
  // Fast-path: when a single field changed, re-validate only that field.
  if (changedPath) {
    const meta = SDM26_SCHEMA.find((m) => m.key === changedPath);
    if (!meta) return prev;
    const v = getAt(draft, changedPath);
    const r = validateField(meta, v);
    const next: Record<string, string> = { ...prev };
    if (r.ok) delete next[changedPath];
    else next[changedPath] = r.message;
    return next;
  }
  // Whole-config: full re-validate.
  return validateAll(SDM26_SCHEMA, draft);
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "loadFromConfig": {
      const snapshot = structuredClone(action.raw);
      return {
        ...initialEditorState,
        draft: snapshot,
        savedSnapshot: snapshot,
        savedPath: action.path,
        isExample: action.isExample,
        fieldErrors: validateAll(SDM26_SCHEMA, snapshot),
      };
    }
    case "loadTemplate": {
      const next = structuredClone(action.raw);
      return {
        ...initialEditorState,
        draft: next,
        // Empty savedSnapshot makes the editor dirty from the start, forcing Save-As.
        savedSnapshot: {},
        savedPath: null,
        isExample: false,
        fieldErrors: validateAll(SDM26_SCHEMA, next),
      };
    }
    case "reset":
      return { ...initialEditorState };

    case "setField": {
      const draft = setAt(state.draft, action.path, action.value);
      const fieldErrors = recomputeFieldErrors(draft, state.fieldErrors, action.path);
      return { ...state, draft, fieldErrors, globalError: null };
    }

    case "addPipeRow": {
      const pipes = [...getPipes(state, action.pipesKey), pipeDefault(action.pipesKey)];
      const draft = setAt(state.draft, action.pipesKey, pipes);
      return { ...state, draft, globalError: null };
    }
    case "removePipeRow": {
      const pipes = getPipes(state, action.pipesKey).filter((_, i) => i !== action.index);
      const draft = setAt(state.draft, action.pipesKey, pipes);
      return { ...state, draft, globalError: null };
    }
    case "duplicatePipeRow": {
      const existing = getPipes(state, action.pipesKey);
      const src = existing[action.index];
      if (!src) return state;
      const copy: Record<string, unknown> = { ...src };
      if (typeof copy.name === "string") copy.name = `${copy.name} (copy)`;
      const pipes = [
        ...existing.slice(0, action.index + 1),
        copy,
        ...existing.slice(action.index + 1),
      ];
      const draft = setAt(state.draft, action.pipesKey, pipes);
      return { ...state, draft, globalError: null };
    }
    case "setPipeRow": {
      const existing = getPipes(state, action.pipesKey);
      const pipes = existing.map((row, i) => (i === action.index ? action.row : row));
      const draft = setAt(state.draft, action.pipesKey, pipes);
      return { ...state, draft, globalError: null };
    }

    case "setCdTable": {
      const path = `${action.valveKey}.cd_table`;
      const draft = setAt(state.draft, path, action.table);
      return { ...state, draft, globalError: null };
    }

    case "changeTopology": {
      const currentTopology = deriveTopology(state.draft);
      if (currentTopology === action.topology) return state;
      let draft = state.draft;
      if (action.topology === "4-1") {
        draft = setAt(draft, "exhaust_secondaries", []);
      } else {
        // 4-2-1: ensure secondaries has at least 2 entries.
        const sec = Array.isArray(state.draft.exhaust_secondaries) ? state.draft.exhaust_secondaries : [];
        const needed = 2;
        const filled = [...sec] as Array<Record<string, unknown>>;
        while (filled.length < needed) filled.push({ ...DEFAULT_SECONDARY_PIPE });
        draft = setAt(draft, "exhaust_secondaries", filled);
      }
      return { ...state, draft, globalError: null };
    }

    case "saveSucceeded": {
      return {
        ...state,
        savedSnapshot: structuredClone(state.draft),
        savedPath: action.path,
        isExample: action.isExample,
        globalError: null,
      };
    }
    case "setGlobalError":
      return { ...state, globalError: action.message };

    case "discardChanges":
      return {
        ...state,
        draft: structuredClone(state.savedSnapshot),
        fieldErrors: validateAll(SDM26_SCHEMA, state.savedSnapshot),
        globalError: null,
      };

    case "openDiff":     return { ...state, diffOpen: true };
    case "closeDiff":    return { ...state, diffOpen: false };
    case "openTemplatePicker":  return { ...state, templatePickerOpen: true };
    case "closeTemplatePicker": return { ...state, templatePickerOpen: false };
  }
}

/// Derived: dirty (anything to save?).
export function isDirty(state: EditorState): boolean {
  return !deepEqual(state.draft, state.savedSnapshot);
}

/// Derived: are there any blocking field errors?
export function hasFieldErrors(state: EditorState): boolean {
  return Object.keys(state.fieldErrors).length > 0;
}

/// Derived: can the user click Save?
export function canSave(state: EditorState): boolean {
  return isDirty(state) && !hasFieldErrors(state);
}

// Re-export to make consumers' lives easier.
export type { FieldMeta };
