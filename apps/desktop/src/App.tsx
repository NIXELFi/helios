import { useEffect, useState } from "react";
import { ChannelStore } from "@helios/store";
import { CursorEmitter, formatClock } from "@helios/lib";
import { loadSampleSession } from "./lib/load-sample";
import { overviewDefault } from "./workspaces/overview-default";
import { Tile } from "./components/Tile";

export default function App() {
  const [store, setStore] = useState<ChannelStore | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cursorUs, setCursorUs] = useState(0);
  const [emitter] = useState(() => new CursorEmitter());

  useEffect(() => {
    loadSampleSession().then(setStore).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => emitter.subscribe(setCursorUs), [emitter]);

  if (error) return <div className="p-8 text-[#EF5350]">{error}</div>;
  if (!store) return <div className="p-8 text-[#7B8088]">Loading sample session…</div>;

  const ext = store.extentUs();

  return (
    <div className="flex flex-col h-screen bg-[#0E0E10] text-[#D8DCE2]">
      <header className="h-10 flex items-center px-3 border-b border-[#2A2C32] text-xs">
        <span className="text-[#FFC627] font-bold">HELIOS</span>
        <span className="ml-3 text-[#7B8088]">sdm26-synthetic-lap.csv</span>
        <span className="ml-auto font-mono-num">{formatClock(cursorUs)}</span>
      </header>

      <main
        className="flex-1 relative cursor-crosshair"
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const frac = (e.clientX - rect.left) / rect.width;
          const t = ext.startUs + frac * (ext.endUs - ext.startUs);
          emitter.emit(t);
        }}
      >
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
