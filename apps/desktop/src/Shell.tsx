import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { ModulePicker, type ModuleId } from "./shell/ModulePicker";
import { VaultModule } from "./modules/vault";
import { CfdModule } from "./modules/cfd";
import LogsApp from "./App";
import { useUpdater } from "./lib/use-updater";
import { UpdateModal } from "./components/UpdateModal";
import { AuthShell, useHeliosAuth, useConnection, userDisplayName } from "./auth/AuthShell";
import { AuthModal } from "./auth/AuthModal";

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

  const { user, client } = useHeliosAuth();
  const { disconnect } = useConnection();
  const [authModalOpen, setAuthModalOpen] = useState(false);

  // Vault is gated on a live logged-in user — the module immediately hits
  // Supabase RLS-protected tables on mount, so rendering it without a session
  // would be a bunch of failed queries. CFD and Logs don't depend on auth.
  const vaultEnabled = user !== null;

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});
  }, []);

  useEffect(() => {
    if (updater.state.kind === "available") setUpdateModalOpen(true);
  }, [updater.state.kind]);

  // If the user navigates away from Vault (or signs out while on Vault),
  // bounce them to Logs so they don't sit on a forbidden module. Otherwise
  // we'd render the Vault notice + hidden ModulePicker activeness mismatch.
  useEffect(() => {
    if (active === "vault" && !vaultEnabled) setActive("logs");
  }, [active, vaultEnabled]);

  function activate(id: ModuleId) {
    // Vault click while logged out routes to the auth modal instead of
    // navigating. Other modules navigate normally.
    if (id === "vault" && !vaultEnabled) {
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

  return (
    <div className="flex h-screen w-screen">
      <ModulePicker
        active={active}
        onSelect={activate}
        appVersion={appVersion}
        updaterState={updater.state}
        onUpdaterClick={handleUpdaterClick}
        userLabel={userLabel}
        onOpenAuth={() => setAuthModalOpen(true)}
        onSignOut={() => void handleSignOut()}
        onDisconnect={() => void handleDisconnect()}
        vaultEnabled={vaultEnabled}
      />
      <main className="relative min-w-0 flex-1">
        {visited.has("logs") && (
          <div className={"absolute inset-0 " + (active === "logs" ? "" : "hidden")}>
            <LogsApp
              appVersion={appVersion}
              playing={logsPlaying}
              onPlayingChange={setLogsPlaying}
            />
          </div>
        )}
        {visited.has("vault") && vaultEnabled && (
          <div className={"absolute inset-0 " + (active === "vault" ? "" : "hidden")}>
            <VaultModule />
          </div>
        )}
        {visited.has("cfd") && (
          <div className={"absolute inset-0 " + (active === "cfd" ? "" : "hidden")}>
            <CfdModule />
          </div>
        )}
      </main>
      {updateModalOpen && (
        <UpdateModal
          state={updater.state}
          playbackBlocked={logsPlaying && active === "logs"}
          onInstall={() => updater.installAndRelaunch()}
          onClose={() => setUpdateModalOpen(false)}
        />
      )}
      <AuthModal open={authModalOpen} onClose={() => setAuthModalOpen(false)} />
    </div>
  );
}
