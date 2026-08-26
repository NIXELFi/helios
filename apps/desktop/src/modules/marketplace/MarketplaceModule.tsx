// The Marketplace module — the backend-driven browse / install / launch surface
// for subteam-built add-ons (Sub-project C). It owns the data + mutation hooks
// (Sub-project B) and hands pure data + callbacks to the Browse / Installed /
// Detail views. EVERY install goes through InstallConsentModal first, so the
// trust decision (especially for high-trust Tier-2 add-ons) is never skipped.
//
// Launching an installed add-on reuses Sub-project A's sandboxed PluginHost via
// PluginStage. NOTE: live launch of untrusted backend bundles is gated on the
// iframe nav-hardening work (Phase 0.2); see runtime/loader.ts `installedBaseUrl`.

import { Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  IconArrowLeft,
  IconPuzzle,
  IconTerminal2,
  IconBolt,
  IconUpload,
  IconRefresh,
  IconHelpCircle,
} from "@tabler/icons-react";
import { useUser } from "@helios/auth";
import { useAvailablePlugins, useInstall, useUninstall, type AvailablePlugin } from "./data/useMarketplace";
import { isMarketplaceDemo, demoLaunchUrl } from "./data/demoStore";
import { loadPlugin, installedBaseUrl, type LoadedPlugin } from "./runtime/loader";
import { PluginHost } from "./runtime/PluginHost";
import type { CallObservation } from "./runtime/broker";
import { BrowseView } from "./views/BrowseView";
import { InstalledView } from "./views/InstalledView";
import { PluginDetail } from "./views/PluginDetail";
import { InstallConsentModal } from "./components/InstallConsentModal";
import { UninstallConfirmModal } from "./components/UninstallConfirmModal";
import { hasHighTrust } from "./components/PermissionList";
import { FIRST_PARTY_APPS, type FirstPartyApp } from "./firstParty";
import { useMyCapabilities } from "../org/data/useOrgData";
import { SubmitWizard } from "./publish/SubmitWizard";
import { HelpDrawer, useHelpDrawer } from "./authoring/HelpDrawer";
import { ReviewView } from "./review/ReviewView";
import { BUNDLED_PLUGINS, type BundledPlugin } from "./bundled";

interface LoadError {
  baseUrl: string;
  message: string;
}

interface ConsoleLine {
  kind: "log" | "notify" | "call";
  text: string;
  level?: "info" | "warn" | "error";
}

type Tab = "browse" | "installed" | "review";

// DEV-ONLY preview flag (see data/demoStore.ts). OFF by default.
const DEMO = isMarketplaceDemo();

export function MarketplaceModule() {
  const { plugins, loading, error, refetch } = useAvailablePlugins();
  const { install, installing, error: installError } = useInstall();
  const { uninstall, removing, error: uninstallError } = useUninstall();

  const [tab, setTab] = useState<Tab>("browse");
  const [wizardOpen, setWizardOpen] = useState(false);
  const { canAnywhere } = useMyCapabilities();
  const help = useHelpDrawer();
  // Publishing and reviewing are capability-gated, but the Add button stays
  // visible either way: it explains what the capability is rather than leaving
  // someone to wonder why the feature seems not to exist.
  const canReview = canAnywhere("marketplace.review");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [consentFor, setConsentFor] = useState<AvailablePlugin | null>(null);
  const [uninstallFor, setUninstallFor] = useState<AvailablePlugin | null>(null);
  const [launch, setLaunch] = useState<LoadedPlugin | null>(null);
  const [launchError, setLaunchError] = useState<LoadError | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [builtIn, setBuiltIn] = useState<FirstPartyApp | null>(null);

  const installed = useMemo(() => plugins.filter((p) => p.installedVersion !== null), [plugins]);
  const detail = useMemo(
    () => (detailId ? (plugins.find((p) => p.id === detailId) ?? null) : null),
    [plugins, detailId],
  );

  const openDetail = useCallback((p: AvailablePlugin) => setDetailId(p.id), []);
  const requestInstall = useCallback((p: AvailablePlugin) => setConsentFor(p), []);

  // Elegant auto-refresh: re-check the catalog whenever the window regains focus
  // (e.g. after a new version is published elsewhere), so new plugins/versions show
  // up without a manual reload. The Refresh button covers same-focus updates.
  useEffect(() => {
    const onFocus = () => refetch();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refetch]);

  const confirmInstall = useCallback(async () => {
    if (!consentFor) return;
    try {
      await install({ id: consentFor.id, version: consentFor.version });
      setConsentFor(null);
      refetch();
    } catch {
      // Error is surfaced inside the modal via `installError`; keep it open.
    }
  }, [consentFor, install, refetch]);

  // Uninstall is destructive and irreversible (server-side deregister + bundle
  // delete + stored-data purge), so the trash icon only OPENS the confirmation —
  // exactly like Install only opens the consent modal. There is no code path from
  // a click to `useUninstall` that skips it.
  const requestUninstall = useCallback((p: AvailablePlugin) => setUninstallFor(p), []);

  const confirmUninstall = useCallback(async () => {
    if (!uninstallFor) return;
    const p = uninstallFor;
    setBusyId(p.id);
    try {
      await uninstall(p.id);
      setUninstallFor(null);
      refetch();
    } catch {
      // Error is surfaced inside the modal via `uninstallError`; keep it open.
    } finally {
      setBusyId(null);
    }
  }, [uninstallFor, uninstall, refetch]);

  const handleOpen = useCallback(async (p: AvailablePlugin) => {
    setLaunchError(null);
    // DEV preview: only the bundled example has a real, openable bundle; the rest
    // would need the verified-install runtime (gated on the 0.2 nav guard).
    const baseUrl = DEMO ? demoLaunchUrl(p.id) : installedBaseUrl(p.id);
    if (DEMO && !baseUrl) {
      setLaunchError({
        baseUrl: p.name,
        message: "Preview mode — launching runs the sandboxed add-on in the full runtime.",
      });
      return;
    }
    setBusyId(p.id);
    try {
      const loaded = await loadPlugin(baseUrl as string);
      setLaunch(loaded);
    } catch (e) {
      setLaunchError({ baseUrl: p.name, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusyId(null);
    }
  }, []);

  // Bundled plugins ship in the build (public/plugins/<id>/) and launch straight
  // from their local base URL into the same sandbox as a marketplace install — no
  // download, no verified-install step.
  //
  // There is no consent modal here, and that is a deliberate choice rather than an
  // oversight (audit P2): consent exists to gate a trust decision the USER is
  // making about a THIRD party's code, and a bundled plugin is neither — it is code
  // we shipped, reviewed at build time, that the member did not choose to bring in.
  // A modal for it would be noise, and noise is what teaches people to click
  // through the modal that does matter.
  //
  // What the missing modal DID leave unguarded is the broker: it grants whatever
  // the local manifest declares, so a bundled manifest that declared a Tier-2
  // permission would get it silently and unreviewed (today that only fails because
  // the one Tier-2 handler throws — a coincidence, not a guard). So the tier bound
  // is asserted here, at load, and fails LOUDLY: a bundled plugin is Tier-0/1 only,
  // and anything higher must go through the marketplace's review + consent path.
  const openBundled = useCallback(async (bp: BundledPlugin) => {
    setLaunchError(null);
    setBusyId(bp.id);
    try {
      const loaded = await loadPlugin(bp.baseUrl);
      if (hasHighTrust(loaded.manifest.permissions)) {
        throw new Error(
          "this bundled add-on declares a high-trust (Tier-2) permission, which bundled add-ons " +
            "are not allowed to hold — it must be published to the marketplace and installed with consent",
        );
      }
      setLaunch(loaded);
    } catch (e) {
      setLaunchError({ baseUrl: bp.name, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusyId(null);
    }
  }, []);

  if (builtIn) {
    return <FirstPartyStage app={builtIn} onBack={() => setBuiltIn(null)} />;
  }
  if (launch) {
    return <PluginStage plugin={launch} onBack={() => setLaunch(null)} />;
  }

  return (
    <div className="h-full overflow-y-auto bg-helios-base">
      <div className="mx-auto max-w-4xl px-6 py-8">
        <header className="mb-6 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-asu-gold">
              <IconPuzzle size={22} strokeWidth={1.5} />
              <h1 className="font-display text-2xl tracking-wide">MARKETPLACE</h1>
              <span className="ml-2 rounded-sm bg-asu-gold px-1.5 py-0.5 text-[10px] font-bold text-helios-base">
                BETA
              </span>
            </div>
            <p className="mt-1 text-xs text-helios-dim">
              Subteam-built tools, sandboxed and run right inside Helios — install the ones you need.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={refetch}
              disabled={loading}
              title="Check for new plugins and versions"
              aria-label="Refresh plugin list"
              className="inline-flex items-center gap-1.5 rounded-sm border border-helios-line px-3 py-1.5 text-xs font-medium text-helios-dim transition-colors hover:border-asu-gold/40 hover:text-asu-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:cursor-wait disabled:opacity-60"
            >
              <IconRefresh size={14} className={loading ? "animate-spin" : undefined} />
              Refresh
            </button>
            <button
              type="button"
              onClick={() => help.openHelp("getting-started")}
              title="How to build and publish a plugin"
              aria-label="Plugin author help"
              className="inline-flex items-center gap-1.5 rounded-sm border border-helios-line px-3 py-1.5 text-xs font-medium text-helios-dim transition-colors hover:border-asu-gold/40 hover:text-asu-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
            >
              <IconHelpCircle size={14} /> Help
            </button>
            <button
              type="button"
              onClick={() => setWizardOpen(true)}
              title="Publish a plugin you have built"
              aria-label="Add to Marketplace"
              className="inline-flex items-center gap-1.5 rounded-sm bg-asu-gold px-3 py-1.5 text-xs font-semibold text-helios-base transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
            >
              <IconUpload size={14} /> Add to Marketplace
            </button>
          </div>
        </header>

        {detail ? (
          <PluginDetail
            plugin={detail}
            busy={busyId === detail.id || installing}
            onBack={() => setDetailId(null)}
            onRequestInstall={requestInstall}
            onUpdate={requestInstall}
            onOpen={handleOpen}
            onUninstall={requestUninstall}
          />
        ) : (
          <>
            <div className="mb-5 flex items-center gap-1 border-b border-helios-line">
              <TabButton active={tab === "browse"} onClick={() => setTab("browse")}>
                Browse
              </TabButton>
              <TabButton active={tab === "installed"} onClick={() => setTab("installed")}>
                Installed{installed.length > 0 ? ` (${installed.length})` : ""}
              </TabButton>
              {canReview && (
                <TabButton active={tab === "review"} onClick={() => setTab("review")}>
                  Review
                </TabButton>
              )}
            </div>

            {launchError && (
              <div className="mb-4 rounded-sm border border-helios-danger/40 bg-helios-danger/10 p-3 text-xs text-helios-danger">
                Couldn’t launch {launchError.baseUrl}: {launchError.message}
              </div>
            )}

            {tab === "browse" ? (
              <>
                {FIRST_PARTY_APPS.length > 0 && (
                  <div className="mb-6">
                    <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-helios-dim">
                      Built-in
                    </div>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      {FIRST_PARTY_APPS.map((app) => (
                        <BuiltInCard key={app.id} app={app} onOpen={() => setBuiltIn(app)} />
                      ))}
                    </div>
                  </div>
                )}
                {BUNDLED_PLUGINS.length > 0 && (
                  <div className="mb-6">
                    <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-helios-dim">
                      Bundled
                    </div>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      {BUNDLED_PLUGINS.map((bp) => (
                        <BundledCard
                          key={bp.id}
                          plugin={bp}
                          busy={busyId === bp.id}
                          onOpen={() => openBundled(bp)}
                        />
                      ))}
                    </div>
                  </div>
                )}
                <BrowseView
                  plugins={plugins}
                  loading={loading}
                  error={error}
                  onOpenDetail={openDetail}
                  onRequestInstall={requestInstall}
                  onOpen={handleOpen}
                />
              </>
            ) : tab === "installed" ? (
              <InstalledView
                plugins={installed}
                loading={loading}
                error={error}
                busyId={busyId}
                onOpen={handleOpen}
                onUpdate={requestInstall}
                onUninstall={requestUninstall}
                onOpenDetail={openDetail}
              />
            ) : (
              <ReviewView
                available={plugins}
                onHelp={help.openHelp}
                onPreviewInstalled={refetch}
              />
            )}
          </>
        )}
      </div>

      {wizardOpen && (
        <SubmitWizard onClose={() => setWizardOpen(false)} onPublished={refetch} />
      )}

      <HelpDrawer
        open={help.open}
        topic={help.topic}
        onClose={help.closeHelp}
        onTopicChange={help.setTopic}
      />

      {consentFor && (
        <InstallConsentModal
          plugin={consentFor}
          installing={installing}
          error={installError}
          onConfirm={confirmInstall}
          onCancel={() => setConsentFor(null)}
        />
      )}

      {uninstallFor && (
        <UninstallConfirmModal
          plugin={uninstallFor}
          removing={removing}
          error={uninstallError}
          onConfirm={confirmUninstall}
          onCancel={() => setUninstallFor(null)}
        />
      )}
    </div>
  );
}

// A first-party built-in app's card — honestly marked "Built-in · full access"
// (NOT "Sandboxed"), since it's trusted native Helios code.
function BuiltInCard({ app, onOpen }: { app: FirstPartyApp; onOpen: () => void }) {
  return (
    <div className="flex flex-col rounded-md border border-helios-line bg-helios-panel p-4 transition-colors hover:border-asu-gold/30">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <IconBolt size={13} className="shrink-0 text-asu-gold" />
          <span className="truncate font-medium text-helios-text">{app.name}</span>
        </div>
        <span
          className="inline-flex shrink-0 items-center rounded-sm border border-asu-gold/40 bg-asu-gold/10 px-1.5 py-0.5 text-[10px] text-asu-gold"
          title="First-party Helios module — runs natively with full access, not sandboxed."
        >
          Built-in
        </span>
      </div>
      {app.subteam && (
        <div className="mt-1 text-[10px] uppercase tracking-[0.14em] text-helios-dim">{app.subteam}</div>
      )}
      <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-helios-dim">{app.description}</p>
      <div className="mt-4 flex items-center gap-2 border-t border-helios-line/50 pt-3.5">
        <button
          type="button"
          onClick={onOpen}
          className="rounded-sm border border-asu-gold/60 px-3 py-1.5 text-xs font-semibold text-asu-gold transition-colors hover:bg-asu-gold/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
        >
          Open
        </button>
        <span className="ml-auto text-[10px] text-helios-dim">First-party · full access</span>
      </div>
    </div>
  );
}

// A bundled plugin's card — ships with Helios but still runs sandboxed, so it's
// marked "Bundled" (not "Built-in") and opens straight into the same locked-down
// PluginHost as a marketplace install, with no download step.
function BundledCard({
  plugin,
  busy,
  onOpen,
}: {
  plugin: BundledPlugin;
  busy: boolean;
  onOpen: () => void;
}) {
  return (
    <div className="flex flex-col rounded-md border border-helios-line bg-helios-panel p-4 transition-colors hover:border-asu-gold/30">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <IconPuzzle size={13} className="shrink-0 text-asu-gold" />
          <span className="truncate font-medium text-helios-text">{plugin.name}</span>
          <span className="shrink-0 text-[10px] text-helios-dim">v{plugin.version}</span>
        </div>
        <span
          className="inline-flex shrink-0 items-center rounded-sm border border-helios-line px-1.5 py-0.5 text-[10px] text-helios-dim"
          title="Ships with Helios — always available, runs in the same sandbox as a marketplace plugin."
        >
          Bundled
        </span>
      </div>
      {plugin.subteam && (
        <div className="mt-1 text-[10px] uppercase tracking-[0.14em] text-helios-dim">{plugin.subteam}</div>
      )}
      <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-helios-dim">{plugin.description}</p>
      <div className="mt-4 flex items-center gap-2 border-t border-helios-line/50 pt-3.5">
        <button
          type="button"
          onClick={onOpen}
          disabled={busy}
          className="rounded-sm border border-asu-gold/60 px-3 py-1.5 text-xs font-semibold text-asu-gold transition-colors hover:bg-asu-gold/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold disabled:opacity-50"
        >
          {busy ? "Opening…" : "Open"}
        </button>
        <span className="ml-auto text-[10px] text-helios-dim">Sandboxed</span>
      </div>
    </div>
  );
}

// Fullscreen mount of a first-party app — its native React component, NOT a
// sandboxed iframe (it's trusted code with full access).
function FirstPartyStage({ app, onBack }: { app: FirstPartyApp; onBack: () => void }) {
  return (
    <div className="flex h-full flex-col bg-helios-base">
      <div className="flex items-center gap-2 border-b border-helios-line px-3 py-2">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 rounded-sm px-2 py-1 text-xs text-helios-dim transition-colors hover:text-asu-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold"
        >
          <IconArrowLeft size={14} /> Marketplace
        </button>
        <span className="text-sm text-helios-text">{app.name}</span>
        <span className="inline-flex items-center gap-1 rounded-sm border border-asu-gold/40 bg-asu-gold/10 px-1.5 py-0.5 text-[10px] text-asu-gold">
          <IconBolt size={10} /> Built-in
        </span>
      </div>
      <div className="relative min-h-0 flex-1">
        <Suspense fallback={<div className="p-6 text-sm text-helios-dim">Loading {app.name}…</div>}>
          <app.Component />
        </Suspense>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        "-mb-px border-b-2 px-3 py-2 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-asu-gold " +
        (active
          ? "border-asu-gold text-asu-gold"
          : "border-transparent text-helios-dim hover:text-helios-text")
      }
    >
      {children}
    </button>
  );
}

function PluginStage({ plugin, onBack }: { plugin: LoadedPlugin; onBack: () => void }) {
  // Read the member here rather than in MarketplaceModule: the stage only exists
  // while an add-on is actually running, which is the only time the plugin's
  // per-user storage namespace is needed.
  const user = useUser();
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
      [
        ...c,
        {
          kind: "call" as const,
          text: `${obs.method} → ${obs.outcome}${obs.code ? ` (${obs.code})` : ""}`,
          level: "warn" as const,
        },
      ].slice(-200),
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
          userId={user?.id ?? null}
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
