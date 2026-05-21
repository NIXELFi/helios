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
    <div className="flex h-full flex-col bg-[#0B0B0D] text-[#D8DCE2]">
      <header className="flex flex-shrink-0 items-center gap-2 border-b border-[#2A2C32] bg-[#0E0E10] px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] uppercase tracking-wider text-[#FFC627]">Engine config</div>
          {loaded ? (
            <FullPathLabel
              path={loaded.path}
              maxLen={140}
              className="text-[10px] text-[#5A5F66]"
            />
          ) : (
            <p className="text-[10px] text-[#5A5F66]">No config loaded.</p>
          )}
        </div>
        <button
          type="button"
          className="rounded-sm border border-[#2A2C32] bg-[#16171B] px-2 py-1 text-[10px] uppercase tracking-wider text-[#9097A0] hover:border-[#FFC627] hover:text-[#FFC627]"
          onClick={handleOpen}
          disabled={loading}
        >
          Open…
        </button>
        <div className="relative">
          <button
            type="button"
            className="rounded-sm border border-[#2A2C32] bg-[#16171B] px-2 py-1 text-[10px] uppercase tracking-wider text-[#9097A0] hover:border-[#FFC627] hover:text-[#FFC627] disabled:opacity-50"
            disabled={loading || examples.length === 0}
            onClick={() => setExamplesOpen((v) => !v)}
            aria-expanded={examplesOpen}
            aria-haspopup="menu"
          >
            Load example ▾
          </button>
          {examplesOpen && examples.length > 0 && (
            <div role="menu" className="absolute right-0 z-10 mt-1 w-80 rounded-sm border border-[#2A2C32] bg-[#0E0E10] shadow-lg">
              {examples.map((ex) => (
                <button
                  key={ex.id}
                  type="button"
                  role="menuitem"
                  className="block w-full border-b border-[#16171B] px-3 py-2 text-left last:border-b-0 hover:bg-[#16171B]"
                  onClick={() => {
                    setExamplesOpen(false);
                    void loadFromPath(ex.path);
                  }}
                >
                  <div className="text-[11px] text-[#D8DCE2]">{ex.name}</div>
                  <div className="mt-0.5 text-[10px] text-[#5A5F66]">{ex.description}</div>
                </button>
              ))}
            </div>
          )}
        </div>
      </header>

      {loadError && (
        <div className="flex-shrink-0 border-b border-red-500/40 bg-red-500/10 px-3 py-1.5 text-[11px] text-red-200" role="alert">
          {loadError}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto p-2">
        {!loaded ? (
          <div className="mx-auto mt-12 max-w-lg rounded-sm border border-[#2A2C32] bg-[#0E0E10] p-8 text-center">
            <div className="text-[11px] uppercase tracking-wider text-[#FFC627]">Open a config to get started</div>
            <p className="mt-3 text-[11px] text-[#9097A0]">
              Phase 1 supports the V1 SDM JSON schema (read-only). Pick an
              existing file or load a bundled example.
            </p>
            <div className="mt-5 flex justify-center gap-2">
              <button
                type="button"
                className="rounded-sm bg-[#FFC627] px-3 py-1 text-[10px] uppercase tracking-wider text-[#0E0E10] hover:bg-yellow-300"
                onClick={handleOpen}
              >
                Open…
              </button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
            {SDM26_GROUPS.map((g) => (
              <section key={g} className="rounded-sm border border-[#2A2C32] bg-[#0E0E10]">
                <div className="border-b border-[#2A2C32] px-2 py-1 text-[10px] uppercase tracking-wider text-[#9097A0]">{g}</div>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1 p-2 text-[11px]">
                  {SDM26_SCHEMA.filter((f) => f.group === g).map((f) => {
                    const v = getNested(loaded.raw, f.key);
                    if (v == null) return null;
                    return (
                      <div key={f.key} className="contents">
                        <dt className="text-[#5A5F66]">{f.label}</dt>
                        <dd className="text-right font-mono tabular-nums text-[#D8DCE2]">
                          {(f.format ? f.format(v) : String(v))}
                          {f.unit ? <span className="ml-1 text-[#5A5F66]">{f.unit}</span> : null}
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
    <section className="rounded-sm border border-[#2A2C32] bg-[#0E0E10] lg:col-span-2">
      <div className="border-b border-[#2A2C32] px-2 py-1 text-[10px] uppercase tracking-wider text-[#9097A0]">{title}</div>
      <div className="overflow-x-auto">
        <table className="w-full text-left font-mono text-[11px]">
          <thead className="bg-[#0B0B0D] text-[10px] uppercase tracking-wider text-[#5A5F66]">
            <tr className="[&>th]:px-2 [&>th]:py-1 [&>th]:font-normal">
              <th>#</th>
              <th>Name</th>
              <th className="text-right">L (mm)</th>
              <th className="text-right">Ø in (mm)</th>
              <th className="text-right">Ø out (mm)</th>
              <th className="text-right">N cells</th>
              <th className="text-right">T wall (K)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.index} className="border-t border-[#16171B] text-[#D8DCE2] hover:bg-[#16171B]/50">
                <td className="px-2 py-1 text-[#5A5F66]">{r.index}</td>
                <td className="px-2 py-1">{r.name ?? "—"}</td>
                <td className="px-2 py-1 text-right tabular-nums">{r.length_mm.toFixed(1)}</td>
                <td className="px-2 py-1 text-right tabular-nums">{r.diameter_mm.toFixed(1)}</td>
                <td className="px-2 py-1 text-right tabular-nums">
                  {r.diameter_out_mm == null ? "—" : r.diameter_out_mm.toFixed(1)}
                </td>
                <td className="px-2 py-1 text-right tabular-nums">{r.n_points}</td>
                <td className="px-2 py-1 text-right tabular-nums">{r.wall_t_K.toFixed(0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
