// The Marketplace module — a launcher for installed plugins. Clicking a working
// add-on opens it fullscreen, sandboxed, in the Helios content area. In the MVP
// the catalog is the bundled example set (registry.ts); Sub-project C turns this
// into the real browse/install experience over the marketplace backend.

import { useCallback, useEffect, useMemo, useState } from "react";
import { IconArrowLeft, IconPuzzle, IconTerminal2, IconAlertTriangle } from "@tabler/icons-react";
import { CAPABILITIES, type PermissionKey } from "@helios/plugin-sdk";
import { LOCAL_PLUGINS } from "./registry";
import { loadPlugin, type LoadedPlugin } from "./runtime/loader";
import { PluginHost } from "./runtime/PluginHost";
import type { CallObservation } from "./runtime/broker";

interface LoadError {
  baseUrl: string;
  message: string;
}

interface ConsoleLine {
  kind: "log" | "notify" | "call";
  text: string;
  level?: "info" | "warn" | "error";
}

export function MarketplaceModule() {
  const [loaded, setLoaded] = useState<LoadedPlugin[]>([]);
  const [errors, setErrors] = useState<LoadError[]>([]);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<LoadedPlugin | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ok: LoadedPlugin[] = [];
      const bad: LoadError[] = [];
      for (const entry of LOCAL_PLUGINS) {
        try {
          ok.push(await loadPlugin(entry.baseUrl));
        } catch (e) {
          bad.push({ baseUrl: entry.baseUrl, message: e instanceof Error ? e.message : String(e) });
        }
      }
      if (!cancelled) {
        setLoaded(ok);
        setErrors(bad);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (active) {
    return <PluginStage plugin={active} onBack={() => setActive(null)} />;
  }

  return (
    <div className="h-full overflow-y-auto bg-helios-base">
      <div className="mx-auto max-w-4xl px-6 py-8">
        <header className="mb-6">
          <div className="flex items-center gap-2 text-asu-gold">
            <IconPuzzle size={22} strokeWidth={1.5} />
            <h1 className="font-helios text-2xl tracking-wide">MARKETPLACE</h1>
            <span className="ml-2 rounded-sm bg-asu-gold px-1.5 py-0.5 text-[10px] font-bold text-helios-base">
              BETA
            </span>
          </div>
          <p className="mt-1 text-xs text-helios-dim">
            Subteam-built add-ons, sandboxed and run inside Helios. Click one to open it fullscreen.
          </p>
        </header>

        {loading && <p className="text-sm text-helios-dim">Loading add-ons…</p>}

        {!loading && loaded.length === 0 && errors.length === 0 && (
          <p className="text-sm text-helios-dim">No add-ons installed yet.</p>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {loaded.map((p) => (
            <PluginCard key={p.manifest.id} plugin={p} onLaunch={() => setActive(p)} />
          ))}
        </div>

        {errors.length > 0 && (
          <div className="mt-6 space-y-2">
            {errors.map((e) => (
              <div
                key={e.baseUrl}
                className="flex items-start gap-2 rounded-sm border border-helios-danger/40 bg-helios-danger/10 p-3 text-xs text-helios-text"
              >
                <IconAlertTriangle size={16} className="mt-0.5 shrink-0 text-helios-danger" />
                <div>
                  <div className="font-semibold">Failed to load {e.baseUrl}</div>
                  <pre className="mt-1 whitespace-pre-wrap text-helios-dim">{e.message}</pre>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PluginCard({ plugin, onLaunch }: { plugin: LoadedPlugin; onLaunch: () => void }) {
  const { manifest } = plugin;
  return (
    <div className="flex flex-col rounded-md border border-helios-line bg-helios-panel p-4">
      <div className="flex items-center justify-between">
        <div className="font-medium text-helios-text">{manifest.name}</div>
        <span className="text-[10px] text-helios-dim">v{manifest.version}</span>
      </div>
      {manifest.subteam && (
        <div className="mt-0.5 text-[10px] uppercase tracking-wider text-helios-dim">{manifest.subteam}</div>
      )}
      {manifest.description && <p className="mt-2 text-xs text-helios-dim">{manifest.description}</p>}
      <div className="mt-3 flex flex-wrap gap-1.5">
        <PermissionBadges permissions={manifest.permissions} />
      </div>
      <button
        type="button"
        onClick={onLaunch}
        className="mt-4 self-start rounded-sm bg-asu-gold px-3 py-1.5 text-xs font-semibold text-helios-base transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
      >
        Launch
      </button>
    </div>
  );
}

function PermissionBadges({ permissions }: { permissions: PermissionKey[] }) {
  if (permissions.length === 0) {
    return (
      <span
        className="rounded-sm bg-helios-line px-1.5 py-0.5 text-[10px] text-helios-dim"
        title="Pure sandbox — UI + compute only, no access to anything outside the box."
      >
        Sandboxed
      </span>
    );
  }
  return (
    <>
      {permissions.map((p) => {
        const info = CAPABILITIES[p];
        const tone =
          info.tier === 2
            ? "bg-helios-danger/15 text-helios-danger"
            : "bg-asu-gold/15 text-asu-gold";
        return (
          <span key={p} className={`rounded-sm px-1.5 py-0.5 text-[10px] ${tone}`} title={info.description}>
            {p}
          </span>
        );
      })}
    </>
  );
}

function PluginStage({ plugin, onBack }: { plugin: LoadedPlugin; onBack: () => void }) {
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [consoleOpen, setConsoleOpen] = useState(false);

  const onLog = useCallback((text: string) => {
    setLines((c) => [...c, { kind: "log" as const, text }].slice(-200));
  }, []);
  const onNotify = useCallback((text: string, level: "info" | "warn" | "error") => {
    setLines((c) => [...c, { kind: "notify" as const, text, level }].slice(-200));
  }, []);
  const onCall = useCallback((obs: CallObservation) => {
    if (obs.outcome === "ok") return; // only surface rejections/errors in the console
    setLines((c) =>
      [...c, { kind: "call" as const, text: `${obs.method} → ${obs.outcome}${obs.code ? ` (${obs.code})` : ""}`, level: "warn" as const }].slice(-200),
    );
  }, []);

  const locale = useMemo(() => (typeof navigator !== "undefined" ? navigator.language : "en-US"), []);

  return (
    <div className="flex h-full flex-col bg-helios-base">
      <div className="flex items-center justify-between border-b border-helios-line px-3 py-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-1 rounded-sm px-2 py-1 text-xs text-helios-dim transition-colors hover:text-asu-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
          >
            <IconArrowLeft size={14} /> Marketplace
          </button>
          <span className="text-sm text-helios-text">{plugin.manifest.name}</span>
          <span className="text-[10px] text-helios-dim">v{plugin.manifest.version}</span>
        </div>
        <button
          type="button"
          onClick={() => setConsoleOpen((o) => !o)}
          aria-pressed={consoleOpen}
          title="Plugin console — host logs and rejected capability calls"
          className={
            "flex items-center gap-1 rounded-sm px-2 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold " +
            (consoleOpen ? "bg-asu-gold/15 text-asu-gold" : "text-helios-dim hover:text-asu-gold")
          }
        >
          <IconTerminal2 size={14} /> Console{lines.length ? ` (${lines.length})` : ""}
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        <PluginHost
          plugin={plugin}
          theme="dark"
          locale={locale}
          onLog={onLog}
          onNotify={onNotify}
          onCall={onCall}
        />
      </div>
      {consoleOpen && (
        <div className="h-40 shrink-0 overflow-y-auto border-t border-helios-line bg-black/40 p-2 font-mono text-[11px]">
          {lines.length === 0 ? (
            <div className="text-helios-dim">No output yet.</div>
          ) : (
            lines.map((line, i) => (
              <div
                key={i}
                className={
                  line.level === "error" || line.kind === "call"
                    ? "text-helios-danger"
                    : line.level === "warn"
                      ? "text-asu-gold"
                      : "text-helios-text"
                }
              >
                <span className="text-helios-dim">[{line.kind}]</span> {line.text}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
