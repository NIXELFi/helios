import { useEffect, useState } from "react";

import { CfdProvider, useCfd } from "./state/CfdContext";
import { EditorProvider, useEditor } from "./editor/state/editor-context";
import { NavRail } from "./components/NavRail";
import { ConfigScreen } from "./screens/ConfigScreen";
import { StudiesScreen } from "./screens/StudiesScreen";
import { ResultsScreen } from "./screens/ResultsScreen";
import { ConfirmModal } from "./components/ConfirmModal";
import type { NavId } from "./state/types";

function CfdShell() {
  const { state, navigateTo } = useCfd();
  const editor = useEditor();
  const [pendingNav, setPendingNav] = useState<NavId | null>(null);

  // Ctrl/Cmd+S → Save, Ctrl/Cmd+Shift+S → Save-As, both editor-scoped.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() !== "s") return;
      // Only intercept when Config is the active screen.
      if (state.activeScreen !== "config") return;
      e.preventDefault();
      if (e.shiftKey) {
        void editor.saveAs();
      } else {
        void editor.save();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [state.activeScreen, editor]);

  function attemptNavigate(id: NavId) {
    if (id === state.activeScreen) return;
    if (editor.isDirty && state.activeScreen === "config") {
      setPendingNav(id);
      return;
    }
    navigateTo(id);
  }

  return (
    <div className="flex h-full w-full bg-[#0B0B0D]">
      <NavRail active={state.activeScreen} onSelect={attemptNavigate} />
      <div className="min-w-0 flex-1">
        {state.activeScreen === "config" && <ConfigScreen />}
        {state.activeScreen === "studies" && <StudiesScreen />}
        {state.activeScreen === "results" && <ResultsScreen />}
      </div>
      <ConfirmModal
        open={pendingNav !== null}
        title="Discard unsaved changes?"
        body="You have unsaved edits to the config. Leaving the editor without saving will discard them."
        confirmLabel="Discard & leave"
        confirmVariant="danger"
        cancelLabel="Stay"
        onCancel={() => setPendingNav(null)}
        onConfirm={() => {
          editor.discard();
          const next = pendingNav!;
          setPendingNav(null);
          navigateTo(next);
        }}
      />
    </div>
  );
}

export function CfdHome() {
  return (
    <CfdProvider>
      <EditorProvider>
        <CfdShell />
      </EditorProvider>
    </CfdProvider>
  );
}
