import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import { useCfd } from "../state/CfdContext";
import { SDM26_GROUPS, SDM26_SCHEMA, extractPipeArray, getNested } from "../lib/sdm26Schema";
import { FullPathLabel } from "../components/PathLabel";
import type { ExampleConfig } from "../state/types";

export function ConfigScreen() {
  const { state, bridge, setLoadedConfig } = useCfd();
  const [examples, setExamples] = useState<ExampleConfig[]>([]);
  const [examplesOpen, setExamplesOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    bridge.listExamples().then(setExamples).catch(() => setExamples([]));
  }, [bridge]);

  async function loadFromPath(path: string) {
    setLoadError(null);
    setLoading(true);
    try {
      const loaded = await bridge.loadConfig(path);
      setLoadedConfig(loaded);
    } catch (e) {
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
    if (typeof picked === "string") {
      await loadFromPath(picked);
    }
  }

  const loaded = state.loadedConfig;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-helios-line bg-helios-base px-4 py-3">
        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-semibold text-helios-text">Engine config</h1>
          {loaded ? (
            <FullPathLabel
              path={loaded.path}
              maxLen={120}
              className="text-xs text-helios-dim"
            />
          ) : (
            <p className="text-xs text-helios-dim">No config loaded.</p>
          )}
        </div>
        <button
          type="button"
          className="rounded border border-helios-line bg-helios-panel px-3 py-1.5 text-sm hover:bg-helios-line"
          onClick={handleOpen}
          disabled={loading}
        >
          Open…
        </button>
        <div className="relative">
          <button
            type="button"
            className="rounded border border-helios-line bg-helios-panel px-3 py-1.5 text-sm hover:bg-helios-line"
            disabled={loading || examples.length === 0}
            onClick={() => setExamplesOpen((v) => !v)}
            aria-expanded={examplesOpen}
            aria-haspopup="menu"
          >
            Load example ▾
          </button>
          {examplesOpen && examples.length > 0 && (
            <div role="menu" className="absolute right-0 z-10 mt-1 w-80 rounded border border-helios-line bg-helios-panel shadow-lg">
              {examples.map((ex) => (
                <button
                  key={ex.id}
                  type="button"
                  role="menuitem"
                  className="block w-full px-3 py-2 text-left text-sm hover:bg-helios-line"
                  onClick={() => {
                    setExamplesOpen(false);
                    void loadFromPath(ex.path);
                  }}
                >
                  <div className="font-medium text-helios-text">{ex.name}</div>
                  <div className="text-xs text-helios-dim">{ex.description}</div>
                </button>
              ))}
            </div>
          )}
        </div>
      </header>

      {loadError && (
        <div className="border-b border-red-500/40 bg-red-500/10 px-4 py-2 text-sm text-red-200" role="alert">
          {loadError}
        </div>
      )}

      <div className="flex-1 overflow-auto p-4">
        {!loaded ? (
          <div className="mx-auto mt-12 max-w-lg rounded border border-helios-line bg-helios-panel p-8 text-center">
            <h2 className="text-base font-semibold text-helios-text">Open a config to get started</h2>
            <p className="mt-2 text-sm text-helios-dim">
              Phase 1 supports the V1 SDM JSON schema (read-only). Pick an
              existing file or load a bundled example.
            </p>
            <div className="mt-5 flex justify-center gap-2">
              <button
                type="button"
                className="rounded bg-asu-gold px-3 py-1.5 text-sm font-medium text-helios-base hover:bg-yellow-300"
                onClick={handleOpen}
              >
                Open…
              </button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {SDM26_GROUPS.map((g) => (
              <section key={g} className="rounded border border-helios-line bg-helios-panel p-4">
                <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-helios-dim">{g}</h3>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
                  {SDM26_SCHEMA.filter((f) => f.group === g).map((f) => {
                    const v = getNested(loaded.raw, f.key);
                    if (v == null) return null;
                    return (
                      <div key={f.key} className="contents">
                        <dt className="text-helios-dim">{f.label}</dt>
                        <dd className="text-right tabular-nums text-helios-text">
                          {(f.format ? f.format(v) : String(v))}
                          {f.unit ? <span className="ml-1 text-helios-dim">{f.unit}</span> : null}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
              </section>
            ))}

            <PipeSection title="Intake runners" rows={extractPipeArray(loaded.raw, "intake_pipes")} />
            <PipeSection title="Exhaust primaries" rows={extractPipeArray(loaded.raw, "exhaust_primaries")} />
            <PipeSection title="Exhaust secondaries" rows={extractPipeArray(loaded.raw, "exhaust_secondaries")} />
          </div>
        )}
      </div>
    </div>
  );
}

function PipeSection({ title, rows }: { title: string; rows: import("../lib/sdm26Schema").PipeRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="rounded border border-helios-line bg-helios-panel p-4 lg:col-span-2">
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-helios-dim">{title}</h3>
      <table className="w-full text-left text-sm">
        <thead className="text-xs uppercase text-helios-dim">
          <tr>
            <th className="py-1 pr-3">#</th>
            <th className="py-1 pr-3">Name</th>
            <th className="py-1 pr-3 text-right">L (mm)</th>
            <th className="py-1 pr-3 text-right">Ø in (mm)</th>
            <th className="py-1 pr-3 text-right">Ø out (mm)</th>
            <th className="py-1 pr-3 text-right">N cells</th>
            <th className="py-1 text-right">T wall (K)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.index} className="border-t border-helios-line">
              <td className="py-1 pr-3 text-helios-dim">{r.index}</td>
              <td className="py-1 pr-3 text-helios-text">{r.name ?? "—"}</td>
              <td className="py-1 pr-3 text-right tabular-nums">{r.length_mm.toFixed(1)}</td>
              <td className="py-1 pr-3 text-right tabular-nums">{r.diameter_mm.toFixed(1)}</td>
              <td className="py-1 pr-3 text-right tabular-nums">
                {r.diameter_out_mm == null ? "—" : r.diameter_out_mm.toFixed(1)}
              </td>
              <td className="py-1 pr-3 text-right tabular-nums">{r.n_points}</td>
              <td className="py-1 text-right tabular-nums">{r.wall_t_K.toFixed(0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
