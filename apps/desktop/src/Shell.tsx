import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { ModulePicker, type ModuleId } from "./shell/ModulePicker";
import { VaultModule } from "./modules/vault";
import { CfdModule } from "./modules/cfd";
import { PmModule } from "./modules/pm";
import { GamesModule } from "./modules/games";
import { AmethystModule } from "./modules/amethyst";
import { MarketplaceModule } from "./modules/marketplace";
import { OrgModule } from "./modules/org";
import LogsApp from "./App";
import { useUpdater } from "./lib/use-updater";
import { UpdateModal } from "./components/UpdateModal";
import { AuthShell, useHeliosAuth, useConnection, useMyRole, userDisplayName, userSubteam } from "./auth/AuthShell";
import { useHeliosPresence } from "./shell/useHeliosPresence";
import { AuthModal } from "./auth/AuthModal";
import { ChangePasswordModal } from "./auth/ChangePasswordModal";
import { useBridgeSync } from "./modules/vault/data/useBridgeSync";
import { BridgeOpHandler } from "./modules/vault/BridgeOpHandler";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { recordBreadcrumb } from "./lib/breadcrumbs";
import { ReportModal } from "./shell/report/ReportModal";
import { ReportsViewer } from "./shell/report/ReportsViewer";
import type { ReportKind } from "./shell/report/types";

// Top-level component. The AuthShell is hoisted ABOVE the module picker so
// every module — Logs, Vault, CFD — can read auth state from the same
// provider. The inner HeliosShell is where the actual UI lives.
export default function ShellRoot() {
  return (
    <AuthShell>
      <HeliosShell />
    </AuthShell>
  );
}

// Each module mounts on first visit and stays mounted afterward. Switching tabs
// just toggles visibility, so LogsApp keeps its loaded sessions / workspace
// state and Vault keeps its Supabase queries — no reload + flash on every
// switch.
//
// The shell also owns the cross-module chrome that should not disappear when
// the user navigates modules: HELIOS wordmark + version + user pill + UpdatesPill
// all live inside the ModulePicker rail; the UpdateModal and AuthModal are
// mounted at the shell level so they can fire over any module.
function HeliosShell() {
  const [active, setActive] = useState<ModuleId>("logs");
  const [visited, setVisited] = useState<Set<ModuleId>>(() => new Set(["logs"]));
  const updater = useUpdater();
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  const [appVersion, setAppVersion] = useState<string>("dev");
  // Lifted from LogsApp so the UpdateModal can disable "Install and restart"
  // mid-playback regardless of which module is currently visible.
  const [logsPlaying, setLogsPlaying] = useState(false);

  const { user, client, loading: authLoading } = useHeliosAuth();
  const { disconnect } = useConnection();
  const myRole = useMyRole();

  // Feed the SOLIDWORKS add-in bridge from the shell — always mounted, every
  // module — so the localhost API stays current with the signed-in session +
  // every vault even when the user is in Logs/CFD or the app is minimized in the
  // tray. No-ops when signed out. See modules/vault/data/useBridgeSync.
  useBridgeSync();

  // STRAY-DROP GUARD: with dragDropEnabled:false, the webview's default action
  // for an unhandled drop (a dragged link, text, image, or OS file released
  // over no drop target) is a FULL-DOCUMENT NAVIGATION — which re-bootstraps
  // the app back to Logs and reads as a crash. Sidebar view rows hit exactly
  // this before (see SortableViewItem). preventDefault-ing dragover/drop at
  // the window level cancels that default for every stray drag, app-wide.
  // Real drop targets (vault import, PM board/calendar dnd) handle their
  // events on the elements themselves, which run BEFORE these bubble-phase
  // listeners — their behavior is unchanged.
  useEffect(() => {
    function onDragOver(e: DragEvent) {
      e.preventDefault();
    }
    function onDrop(e: DragEvent) {
      e.preventDefault();
    }
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, []);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [changePwOpen, setChangePwOpen] = useState(false);
  // Bug/feature report: which kind the modal opened with (null = closed), plus
  // the admin-only reports viewer.
  const [reportKind, setReportKind] = useState<ReportKind | null>(null);
  const [reportsOpen, setReportsOpen] = useState(false);

  // Vault is gated on a live logged-in user — the module immediately hits
  // Supabase RLS-protected tables on mount, so rendering it without a session
  // would be a bunch of failed queries. CFD and Logs don't depend on auth.
  const vaultEnabled = user !== null;
  // PM is gated identically to Vault — it hits RLS-protected pm.* tables on
  // mount, so it needs a live signed-in session from the main app.
  const pmEnabled = user !== null;
  const gamesEnabled = user !== null;
  // Org & Access is admin-only tooling (owner/admin) AND needs a live session —
  // it hits RLS-protected pm.* tables. Non-admins never see the rail entry.
  const orgEnabled = user !== null && (myRole === "owner" || myRole === "admin");
  // During the boot getSession() window we don't yet KNOW whether a returning
  // user is signed in. Don't present the disabled "Sign in to use Vault" state
  // (it flashes for a signed-in user) and don't bounce off Vault until auth
  // resolves — gate both on `authLoading`.

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});
  }, []);

  // Record module navigation as a breadcrumb so a bug report shows where the
  // user had been just before filing it.
  useEffect(() => {
    recordBreadcrumb("nav", `module -> ${active}`);
  }, [active]);

  // True once the user has clicked "Install and restart". Used to keep the
  // UpdateModal visible (with an error + retry) if the install fails and the
  // updater flips to `offline` — otherwise the modal would silently unmount
  // mid-install with no explanation. Reset whenever the modal is closed.
  const [installAttempted, setInstallAttempted] = useState(false);

  // Auto-open the UpdateModal when an update becomes available — BUT not on top
  // of an already-open AuthModal / ChangePasswordModal. Stacking modals breaks
  // Escape (one keypress would close both) and is disorienting. If another
  // modal is open we hold off; the moment it closes (this effect re-runs on the
  // anotherModalOpen dep) the update modal pops.
  const anotherModalOpen = authModalOpen || changePwOpen;
  useEffect(() => {
    if (updater.state.kind !== "available") return;
    if (anotherModalOpen) return;
    setUpdateModalOpen(true);
  }, [updater.state.kind, anotherModalOpen]);

  // If the user navigates away from Vault (or signs out while on Vault),
  // bounce them to Logs so they don't sit on a forbidden module. Otherwise
  // we'd render the Vault notice + hidden ModulePicker activeness mismatch.
  //
  // We also drop "vault" from the visited set the moment access is revoked.
  // Without this, the module stays "visited" and remounts HIDDEN the instant
  // the user signs back in — firing RLS-protected Supabase queries the user
  // never asked for. Clearing it means Vault only re-mounts on an explicit
  // re-visit (active === "vault").
  useEffect(() => {
    // Hold off while auth is still resolving — a returning signed-in user is
    // briefly `user === null` during boot getSession(), and bouncing/dropping
    // Vault here would flash the forbidden state before their session lands.
    if (authLoading) return;
    if (vaultEnabled && pmEnabled && gamesEnabled) return;
    if (active === "vault" || active === "pm" || active === "games") setActive("logs");
    setVisited((prev) => {
      if (!prev.has("vault") && !prev.has("pm") && !prev.has("games")) return prev;
      const next = new Set(prev);
      next.delete("vault");
      next.delete("pm");
      next.delete("games");
      return next;
    });
  }, [active, vaultEnabled, pmEnabled, gamesEnabled, authLoading]);

  // Bounce off Org & Access if access is lost (sign-out, or role no longer
  // admin) — mirrors the Vault/PM/Games guard but keyed on its own gate.
  useEffect(() => {
    if (authLoading) return;
    if (orgEnabled) return;
    if (active === "org") setActive("logs");
    setVisited((prev) => {
      if (!prev.has("org")) return prev;
      const next = new Set(prev);
      next.delete("org");
      return next;
    });
  }, [active, orgEnabled, authLoading]);

  function activate(id: ModuleId) {
    // Org & Access is admin-only; the rail entry is hidden for everyone else, so
    // a stray activation just no-ops (no auth modal — it isn't a sign-in gate).
    if (id === "org" && !orgEnabled) return;
    if (
      (id === "vault" && !vaultEnabled) ||
      (id === "pm" && !pmEnabled) ||
      (id === "games" && !gamesEnabled)
    ) {
      // While auth is still resolving we don't yet know if this is a returning
      // signed-in user; swallow the click rather than prematurely popping the
      // auth modal in front of them.
      if (authLoading) return;
      // Vault/PM click while logged out routes to the auth modal instead of
      // navigating. Other modules navigate normally.
      setAuthModalOpen(true);
      return;
    }
    setActive(id);
    setVisited((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }

  function handleUpdaterClick() {
    const k = updater.state.kind;
    if (k === "up_to_date" || k === "offline") {
      updater.recheck();
    } else if (k === "available" || k === "downloading" || k === "installing") {
      setUpdateModalOpen(true);
    }
  }

  async function handleSignOut() {
    if (!client) return;
    try {
      await client.auth.signOut();
    } catch {
      // Network failure here is benign — onAuthStateChange will still fire
      // SIGNED_OUT locally and the UI updates.
    }
  }

  async function handleDisconnect() {
    await disconnect();
  }

  const userLabel = user ? userDisplayName(user) : null;
  const userSubteamLabel = user ? userSubteam(user) : null;

  // App-wide presence: track everyone signed into Helios (every module, not
  // just PM/Vault) via one shared realtime channel. The roster is only
  // surfaced to admins/owners — but we always TRACK (so an admin sees everyone,
  // including non-admins) and only gate the VIEW.
  const presenceRoster = useHeliosPresence({
    client,
    userId: user?.id ?? null,
    name: userLabel ?? "Unknown",
    subteam: userSubteamLabel,
    module: active,
  });
  const canSeePresence = myRole === "owner" || myRole === "admin";

  return (
    <div className="flex h-screen w-screen">
      <ModulePicker
        active={active}
        onSelect={activate}
        appVersion={appVersion}
        updaterState={updater.state}
        onUpdaterClick={handleUpdaterClick}
        userLabel={userLabel}
        userSubteam={userSubteamLabel}
        userRole={myRole}
        onOpenAuth={() => setAuthModalOpen(true)}
        onSignOut={() => void handleSignOut()}
        onDisconnect={() => void handleDisconnect()}
        onChangePassword={() => setChangePwOpen(true)}
        vaultEnabled={vaultEnabled}
        pmEnabled={pmEnabled}
        gamesEnabled={gamesEnabled}
        orgEnabled={orgEnabled}
        authLoading={authLoading}
        presence={
          canSeePresence ? { users: presenceRoster, currentUserId: user?.id ?? null } : null
        }
        onOpenReport={setReportKind}
        canViewReports={canSeePresence}
        onOpenReports={() => setReportsOpen(true)}
      />
      <main className="relative min-w-0 flex-1">
        {/* Each module gets its own boundary so a crash in one (an unexpected
            data shape, a render bug) shows a contained error in that pane while
            the rail + sibling modules stay usable. */}
        {visited.has("logs") && (
          <div className={"absolute inset-0 " + (active === "logs" ? "" : "hidden")}>
            <ErrorBoundary label="Logs" compact>
              <LogsApp
                appVersion={appVersion}
                playing={logsPlaying}
                onPlayingChange={setLogsPlaying}
                keyboardShortcutsEnabled={active === "logs"}
              />
            </ErrorBoundary>
          </div>
        )}
        {visited.has("vault") && vaultEnabled && (
          <div className={"absolute inset-0 " + (active === "vault" ? "" : "hidden")}>
            <ErrorBoundary label="Vault" compact>
              <VaultModule />
            </ErrorBoundary>
          </div>
        )}
        {visited.has("cfd") && (
          <div className={"absolute inset-0 " + (active === "cfd" ? "" : "hidden")}>
            <ErrorBoundary label="CFD" compact>
              <CfdModule />
            </ErrorBoundary>
          </div>
        )}
        {visited.has("pm") && pmEnabled && (
          <div className={"absolute inset-0 " + (active === "pm" ? "" : "hidden")}>
            <ErrorBoundary label="PM" compact>
              <PmModule />
            </ErrorBoundary>
          </div>
        )}
        {visited.has("games") && gamesEnabled && (
          <div className={"absolute inset-0 " + (active === "games" ? "" : "hidden")}>
            <ErrorBoundary label="Games" compact>
              <GamesModule paused={active !== "games"} />
            </ErrorBoundary>
          </div>
        )}
        {visited.has("amethyst") && (
          <div className={"absolute inset-0 " + (active === "amethyst" ? "" : "hidden")}>
            <ErrorBoundary label="Amethyst" compact>
              <AmethystModule />
            </ErrorBoundary>
          </div>
        )}
        {visited.has("marketplace") && (
          <div className={"absolute inset-0 " + (active === "marketplace" ? "" : "hidden")}>
            <ErrorBoundary label="Marketplace" compact>
              <MarketplaceModule />
            </ErrorBoundary>
          </div>
        )}
        {visited.has("org") && orgEnabled && (
          <div className={"absolute inset-0 " + (active === "org" ? "" : "hidden")}>
            <ErrorBoundary label="Org & Access" compact>
              <OrgModule />
            </ErrorBoundary>
          </div>
        )}
      </main>
      {updateModalOpen && (
        <UpdateModal
          state={updater.state}
          playbackBlocked={logsPlaying && active === "logs"}
          // A failed install flips the updater to `offline`; without this the
          // modal would unmount silently. installAttempted keeps it open so the
          // modal can surface the error + a retry instead of vanishing.
          installAttempted={installAttempted}
          onInstall={() => {
            setInstallAttempted(true);
            void updater.installAndRelaunch();
          }}
          onRetry={() => {
            // From `offline` an install can't be re-triggered directly
            // (installAndRelaunch requires `available`). Recheck to get back to
            // an installable state and drop the failed flag so the modal flows
            // normally once the update is re-found.
            setInstallAttempted(false);
            updater.recheck();
          }}
          onClose={() => {
            setUpdateModalOpen(false);
            setInstallAttempted(false);
          }}
        />
      )}
      {/* Runs the add-in bridge's blob ops (check-in / get-latest) using the
          vault's tested upload/download code. Mounted only when signed in. */}
      {vaultEnabled && <BridgeOpHandler />}
      <AuthModal open={authModalOpen} onClose={() => setAuthModalOpen(false)} />
      <ChangePasswordModal
        open={changePwOpen}
        client={client}
        onClose={() => setChangePwOpen(false)}
      />
      {reportKind && (
        <ReportModal
          kind={reportKind}
          module={active}
          appVersion={appVersion}
          onClose={() => setReportKind(null)}
        />
      )}
      {reportsOpen && <ReportsViewer onClose={() => setReportsOpen(false)} />}
    </div>
  );
}
