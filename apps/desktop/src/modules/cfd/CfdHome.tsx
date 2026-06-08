import { useEffect, useState } from "react";

import { CfdProvider, useCfd } from "./state/CfdContext";
import { EditorProvider, useEditor } from "./editor/state/editor-context";
import { NavRail, formatDataSize as formatDataSizeForDialog } from "./components/NavRail";
import { ConfigScreen } from "./screens/ConfigScreen";
import { StudiesScreen } from "./screens/StudiesScreen";
import { ResultsScreen } from "./screens/ResultsScreen";
import { PerformanceScreen } from "./screens/PerformanceScreen";
import { ConfirmModal } from "./components/ConfirmModal";
import type { NavId } from "./state/types";

import "./cfd.css";

function CfdShell() {
  const { state, navigateTo, bridge } = useCfd();
  const editor = useEditor();
  const [pendingNav, setPendingNav] = useState<NavId | null>(null);
  // Captures-directory size + a "we're about to wipe it" confirm flag. null
  // means "loading"; the NavRail renders "…" so chrome doesn't reflow once
  // the real number lands. We refresh after every job-done event so the
  // size stays current as new studies write captures, and after a clear so
  // the user sees the zero immediately.
  const [dataUsageBytes, setDataUsageBytes] = useState<number | null>(null);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void bridge.dataUsageBytes()
      .then((n) => { if (!cancelled) setDataUsageBytes(n); })
      .catch(() => { if (!cancelled) setDataUsageBytes(0); });
    return () => { cancelled = true; };
  }, [bridge]);

  // Re-measure whenever a job completes, since that's when new captures
  // hit disk. Subscribing here (not just in CfdContext) is fine — bridge
  // .subscribe returns an unsubscribe per call, so cleanup is per-effect.
  useEffect(() => {
    let unsub: (() => Promise<void>) | null = null;
    let cancelled = false;
    void bridge.subscribe((e) => {
      if (e.name === "cfd:job-done" || e.name === "cfd:job-cancelled" || e.name === "cfd:job-error") {
        void bridge.dataUsageBytes()
          .then((n) => { if (!cancelled) setDataUsageBytes(n); })
          .catch(() => {});
      }
    }).then((u) => { unsub = u; if (cancelled) void u(); });
    return () => {
      cancelled = true;
      if (unsub) void unsub();
    };
  }, [bridge]);

  async function handleClearConfirm() {
    setClearBusy(true);
    setClearError(null);
    try {
      await bridge.clearAllData();
      const n = await bridge.dataUsageBytes();
      setDataUsageBytes(n);
      setClearConfirmOpen(false);
    } catch (e) {
      setClearError(e instanceof Error ? e.message : String(e));
    } finally {
      setClearBusy(false);
    }
  }

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
    <div className="cfd-root flex h-full w-full bg-helios-base">
      <NavRail
        active={state.activeScreen}
        onSelect={attemptNavigate}
        dataUsageBytes={dataUsageBytes}
        onRequestClearData={() => {
          setClearError(null);
          setClearConfirmOpen(true);
        }}
      />
      <div className="min-w-0 flex-1">
        {state.activeScreen === "config" && <ConfigScreen />}
        {state.activeScreen === "studies" && <StudiesScreen />}
        {state.activeScreen === "results" && <ResultsScreen />}
        {state.activeScreen === "performance" && <PerformanceScreen />}
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
      <ConfirmModal
        open={clearConfirmOpen}
        title="Clear all CFD data?"
        body={
          <>
            <p>
              This deletes every captured run under{" "}
              <code className="font-mono-num text-helios-text">~/Documents/Helios/cfd/captures</code>
              {" "}— P-V loops, pipe profiles, wave frames, study results, all of it.
            </p>
            <p className="mt-2">
              <span className="font-semibold text-helios-text">Engine configs are NOT touched.</span>{" "}
              They live under <code className="font-mono-num text-helios-text">…/cfd/configs</code> and
              survive this operation. You can re-run any study afterwards.
            </p>
            <p className="mt-2 text-helios-dim">
              Current usage: <span className="font-mono-num text-helios-text">
                {dataUsageBytes === null ? "…" : formatDataSizeForDialog(dataUsageBytes)}
              </span>
            </p>
            {clearError && (
              <p className="mt-2 text-red-300">Error: {clearError}</p>
            )}
          </>
        }
        confirmLabel={clearBusy ? "Clearing…" : "Delete everything"}
        confirmVariant="danger"
        cancelLabel="Cancel"
        onCancel={() => { if (!clearBusy) setClearConfirmOpen(false); }}
        onConfirm={() => { if (!clearBusy) void handleClearConfirm(); }}
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
