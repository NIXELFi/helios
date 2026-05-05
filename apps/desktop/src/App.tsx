import { useEffect, useState } from "react";
import { ChannelStore } from "@helios/store";
import { CursorEmitter, formatClock } from "@helios/lib";
import { loadSampleSession, SAMPLES } from "./lib/load-sample";
import { overviewDefault } from "./workspaces/overview-default";
import { Tile } from "./components/Tile";

export default function App() {
  const [sampleId, setSampleId] = useState(SAMPLES[0]!.id);
  const [store, setStore] = useState<ChannelStore | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [emitter] = useState(() => new CursorEmitter());

  useEffect(() => {
    setStore(null);
    setError(null);
    const sample = SAMPLES.find((s) => s.id === sampleId) ?? SAMPLES[0]!;
    loadSampleSession(sample.resource)
      .then(setStore)
      .catch((e) => setError(String(e)));
  }, [sampleId]);

  if (error) return <div className="p-8 text-[#EF5350]">{error}</div>;
  if (!store) return <div className="p-8 text-[#7B8088]">Loading sample session…</div>;

  const ext = store.extentUs();

  return (
    <div className="flex flex-col h-screen bg-[#0E0E10] text-[#D8DCE2]">
      <header className="h-10 flex items-center px-3 border-b border-[#2A2C32] text-xs">
        <span className="text-[#FFC627] font-bold">HELIOS</span>
        <select
          value={sampleId}
          onChange={(e) => setSampleId(e.target.value)}
          className="ml-3 bg-[#16171B] text-[#D8DCE2] border border-[#2A2C32] rounded-sm px-2 py-0.5 text-xs focus:outline-none focus:border-[#FFC627] cursor-pointer"
        >
          {SAMPLES.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>
        <span className="ml-auto font-mono-num"><CursorClock emitter={emitter} /></span>
      </header>

      <main className="flex-1 relative">
        {overviewDefault.map((spec) => (
          <Tile key={spec.id} spec={spec} store={store} cursorEmitter={emitter} />
        ))}
      </main>

      <footer className="h-6 flex items-center px-3 border-t border-[#2A2C32] text-[10px] text-[#7B8088]">
        channels {store.list().length} · range {(ext.endUs - ext.startUs) / 1_000_000}s
      </footer>
    </div>
  );
}

function CursorClock({ emitter }: { emitter: CursorEmitter }) {
  const [t, setT] = useState(emitter.get());
  useEffect(() => emitter.subscribe(setT), [emitter]);
  return <>{formatClock(t)}</>;
}
