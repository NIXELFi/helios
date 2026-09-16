// Diff modal: compare the editor's draft (or saved snapshot) against
// a second config picked via file dialog or bundled example dropdown.
// Renders the diff grouped by schema section. Sections with no changes
// collapse to a one-line summary.

import { useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { useCfd } from "../../state/CfdContext";
import { useEditor } from "../state/editor-context";
import { diffConfigs, groupDiff, type DiffEntry } from "./diff-engine";
import { basename } from "../../lib/cfdPath";
import type { ExampleConfig, LoadedConfig } from "../../state/types";

type SourceSide = "draft" | "snapshot";

interface Props {
  onClose: () => void;
}

export function ConfigDiffModal({ onClose }: Props) {
  const { bridge } = useCfd();
  const editor = useEditor();
  const { state } = editor;
  const [side, setSide] = useState<SourceSide>("snapshot");
  const [otherCfg, setOtherCfg] = useState<LoadedConfig | null>(null);
  const [examples, setExamples] = useState<ExampleConfig[]>([]);
  const [examplesOpen, setExamplesOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    bridge.listExamples().then(setExamples).catch(() => setExamples([]));
  }, [bridge]);

  async function loadOther(path: string) {
    setLoadError(null);
    setLoading(true);
    try {
      const cfg = await bridge.loadConfig(path);
      setOtherCfg(cfg);
    } catch (e) {
      setOtherCfg(null);
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function handleOpen() {
    const picked = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "Engine config", extensions: ["json"] }],
    });
    if (typeof picked === "string") await loadOther(picked);
  }

  const left = side === "draft" ? state.draft : state.savedSnapshot;

  const grouped = useMemo(() => {
    if (!otherCfg) return [];
    return groupDiff(diffConfigs(left, otherCfg.raw));
  }, [left, otherCfg]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="cfd-diff-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex h-[min(92vh,800px)] w-[min(96vw,1100px)] flex-col rounded-sm border border-helios-line bg-helios-base text-helios-text shadow-xl">
        <div className="flex flex-shrink-0 items-center justify-between border-b border-helios-line px-3 py-1.5">
          <div id="cfd-diff-title" className="text-[11px] uppercase tracking-wider text-asu-gold">
            Compare configs
          </div>
          <button
            type="button"
            className="text-[10px] uppercase tracking-wider text-helios-muted hover:text-helios-text"
            onClick={onClose}
          >
            Esc
          </button>
        </div>

        {/* Source picker strip */}
        <div className="flex flex-shrink-0 items-center gap-3 border-b border-helios-line bg-helios-deep px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-helios-muted">
            Left side
          </div>
          {editor.isDirty ? (
            <div className="flex items-center gap-2">
              <RadioButton checked={side === "snapshot"} onChange={() => setSide("snapshot")} label="Last saved" />
              <RadioButton checked={side === "draft"} onChange={() => setSide("draft")} label="Current draft (unsaved)" />
            </div>
          ) : (
            <span className="text-[11px] text-helios-dim">{basename(state.savedPath ?? "(unsaved)")}</span>
          )}

          <div className="mx-2 text-[10px] uppercase tracking-wider text-helios-muted">vs</div>

          <div className="text-[10px] uppercase tracking-wider text-helios-muted">Right side</div>
          {otherCfg ? (
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-helios-dim" title={otherCfg.path}>{basename(otherCfg.path)}</span>
              <button
                type="button"
                className="text-[10px] uppercase tracking-wider text-helios-muted hover:text-asu-gold"
                onClick={() => setOtherCfg(null)}
              >
                change
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="rounded-sm border border-helios-line bg-helios-panel px-2 py-1 text-[10px] uppercase tracking-wider text-helios-dim hover:border-asu-gold hover:text-asu-gold"
                onClick={handleOpen}
                disabled={loading}
              >
                Open file…
              </button>
              <div className="relative">
                <button
                  type="button"
                  className="rounded-sm border border-helios-line bg-helios-panel px-2 py-1 text-[10px] uppercase tracking-wider text-helios-dim hover:border-asu-gold hover:text-asu-gold disabled:opacity-50"
                  disabled={loading || examples.length === 0}
                  onClick={() => setExamplesOpen((v) => !v)}
                >
                  Bundled ▾
                </button>
                {examplesOpen && (
                  <div role="menu" className="absolute right-0 z-10 mt-1 w-72 rounded-sm border border-helios-line bg-helios-base shadow-lg">
                    {examples.map((ex) => (
                      <button
                        key={ex.id}
                        type="button"
                        className="block w-full border-b border-helios-panel px-3 py-2 text-left last:border-b-0 hover:bg-helios-panel"
                        onClick={() => {
                          setExamplesOpen(false);
                          void loadOther(ex.path);
                        }}
                      >
                        <div className="text-[11px] text-helios-text">{ex.name}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {loadError && (
          <div className="flex-shrink-0 border-b border-red-500/40 bg-red-500/10 px-3 py-1.5 text-[11px] text-red-200" role="alert">
            Couldn't load comparison config: {loadError}{" "}
            <button
              type="button"
              className="ml-2 underline hover:text-red-100"
              onClick={() => { setLoadError(null); void handleOpen(); }}
            >
              Pick a different file
            </button>
          </div>
        )}

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-auto p-2">
          {!otherCfg ? (
            <div className="m-8 rounded-sm border border-helios-line bg-helios-deep p-8 text-center text-[11px] text-helios-muted">
              Pick a config to compare against.
            </div>
          ) : (
            grouped.map((sec) => <DiffSection key={sec.group} group={sec.group} entries={sec.entries} />)
          )}
        </div>
      </div>
    </div>
  );
}

function RadioButton({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-1 text-[11px] text-helios-text">
      <input type="radio" checked={checked} onChange={onChange} className="accent-asu-gold" />
      {label}
    </label>
  );
}

function DiffSection({ group, entries }: { group: string; entries: ReadonlyArray<DiffEntry> }) {
  const changed = entries.filter((e) => e.kind !== "same");
  const [expanded, setExpanded] = useState(changed.length > 0);

  return (
    <section className="mb-2 rounded-sm border border-helios-line bg-helios-base">
      <button
        type="button"
        className="flex w-full items-center justify-between border-b border-helios-line px-2 py-1 text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="text-[10px] uppercase tracking-wider text-helios-dim">
          {expanded ? "▼" : "▶"} {group}
        </span>
        <span className="text-[10px] text-helios-muted">
          {changed.length === 0 ? "no changes" : `${changed.length} change${changed.length === 1 ? "" : "s"}`}
        </span>
      </button>
      {expanded && (
        <table className="w-full font-mono text-[11px]">
          <thead className="bg-helios-deep text-[10px] uppercase tracking-wider text-helios-muted">
            <tr className="[&>th]:px-2 [&>th]:py-1 [&>th]:font-normal">
              <th className="text-left">Field</th>
              <th className="text-right">Left</th>
              <th className="text-right">Right</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr
                key={e.key}
                className={
                  "border-t border-helios-panel " +
                  (e.kind === "same"
                    ? "text-helios-muted"
                    : e.kind === "changed"
                      ? "bg-asu-gold/5 text-helios-text"
                      : e.kind === "added"
                        ? "bg-green-500/5 text-green-200"
                        : "bg-red-500/5 text-red-200")
                }
              >
                <td className="px-2 py-1 text-helios-dim">
                  {e.label}{e.unit ? <span className="ml-1 text-helios-muted">{e.unit}</span> : null}
                </td>
                <td className="px-2 py-1 text-right tabular-nums">{e.formatted.left}</td>
                <td className="px-2 py-1 text-right tabular-nums">{e.formatted.right}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
