import { useMemo, useState, useEffect } from "react";
import { useUser } from "@helios/auth";
import { NavRail, type VaultScreenId } from "./components/NavRail";
import { DownloadModeWelcome } from "./components/DownloadModeWelcome";
import { ToastHost } from "./components/ToastHost";
import { NotificationFeed } from "./components/NotificationFeed";
import { BrowseScreen } from "./screens/BrowseScreen";
import { InsightsScreen } from "./screens/InsightsScreen";
import { HistoryScreen } from "./screens/HistoryScreen";
import { WhoHasWhatScreen } from "./screens/WhoHasWhatScreen";
import { RecycleScreen } from "./screens/RecycleScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { useLocks } from "./data/useLocks";
import { useActiveVault } from "./data/useActiveVault";
import { VaultFilesProvider, useVaultFiles } from "./data/vault-files-context";
import { useVaultRealtimeFeed } from "./data/useVaultRealtime";
import { useVaultUsers } from "./data/useVaultUsers";
import { useWatchedFiles } from "./data/useWatchedFiles";
import { useNotifications } from "./data/useNotifications";
import { WatchedFilesContext } from "./data/WatchedFilesContext";
import type { VaultId } from "./data/types";

/**
 * Owns the two things there must be exactly ONE of per vault:
 *   - the realtime channel (useVaultRealtimeFeed → the vault-events bus), and
 *   - the whole-vault file catalog (VaultFilesProvider → useAllFiles).
 * Both used to be opened twice — the channel by the file lists and the
 * notification feed, the catalog by this component and BrowseScreen — which
 * the 2026-09-09 load audit measured as 30% of prod database time plus a
 * doubled realtime subscription count.
 */
export function VaultHome() {
  const { activeVaultId: vaultId } = useActiveVault();
  useVaultRealtimeFeed(vaultId ?? undefined);
  return (
    <VaultFilesProvider vaultId={vaultId ?? undefined}>
      <VaultHomeShell vaultId={vaultId ?? undefined} />
    </VaultFilesProvider>
  );
}

function VaultHomeShell({ vaultId }: { vaultId: VaultId | undefined }) {
  const [active, setActive] = useState<VaultScreenId>("browse");
  // App Settings → Data → "Open Vault settings" lands here after the Shell
  // switches modules; decoupled via a window event so the Shell needs no
  // handle into this component.
  useEffect(() => {
    function onNav(e: Event) {
      const screen = (e as CustomEvent<VaultScreenId>).detail;
      if (screen) setActive(screen);
    }
    window.addEventListener("helios:vault:screen", onNav);
    return () => window.removeEventListener("helios:vault:screen", onNav);
  }, []);
  const user = useUser();
  // Live count of the current user's checkouts, shown as a badge on the
  // "Who has what" rail entry — one glance answers "do I have anything out?".
  // useLocks subscribes to lock-change broadcasts, so the badge updates the
  // moment a checkout/check-in lands anywhere in the module.
  const { data: locks } = useLocks();
  const myCheckouts = useMemo(
    () => (locks ?? []).filter((l) => l.user_id === (user?.id ?? "")).length,
    [locks, user],
  );

  // Single useWatchedFiles instance owned here and shared via WatchedFilesContext
  // so FileDetailPanel's star and this notification feed both read/write the
  // same React state.  A second independent instance (formerly in BrowseScreen)
  // caused the notification feed to miss stars toggled in the detail panel
  // within the same session (HIGH defect).
  const watchedFiles = useWatchedFiles(vaultId);
  // The shared catalog gives a flat file list across the whole vault — used to
  // resolve fileId → name in notifications without requiring a per-folder query.
  const { data: allFiles } = useVaultFiles();
  const { items: notifItems, unread, markAllRead, clear: clearNotifs } = useNotifications(
    vaultId,
    watchedFiles.watched,
    allFiles ?? [],
  );
  // Resolve notification actor ids → human labels (email / display name) so the
  // feed shows "by jane@asu.edu" instead of a raw UUID prefix. Best-effort: the
  // RPC raises for non-members and the feed falls back to the id prefix.
  const { data: vaultUsers } = useVaultUsers(vaultId ?? null);
  const actorNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of vaultUsers ?? []) {
      const label = u.email ?? u.display_name;
      if (label) m.set(u.user_id, label);
    }
    return m;
  }, [vaultUsers]);

  // Jump to file: switch to browse screen. Full navigation (open the folder +
  // select the file) requires more wiring; for v1 this at least surfaces the
  // browse tab so the user knows where to look.
  function handleJumpToFile(_fileId: string) {
    setActive("browse");
  }

  return (
    <WatchedFilesContext.Provider value={watchedFiles}>
      <div className="flex h-full">
        <NavRail
          active={active}
          onSelect={setActive}
          myCheckouts={myCheckouts}
          notificationFeed={
            <NotificationFeed
              items={notifItems}
              unread={unread}
              onMarkAllRead={markAllRead}
              onClear={clearNotifs}
              onJumpToFile={handleJumpToFile}
              actorNames={actorNames}
            />
          }
        />
        <main className="flex-1 overflow-hidden">
          {active === "browse" ? <BrowseScreen /> : null}
          {active === "insights" ? <InsightsScreen /> : null}
          {active === "history" ? <HistoryScreen /> : null}
          {active === "who" ? <WhoHasWhatScreen /> : null}
          {active === "deleted" ? <RecycleScreen /> : null}
          {active === "settings" ? <SettingsScreen /> : null}
        </main>
        <DownloadModeWelcome />
        <ToastHost />
      </div>
    </WatchedFilesContext.Provider>
  );
}
