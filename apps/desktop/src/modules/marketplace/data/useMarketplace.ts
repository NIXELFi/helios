// Client data layer for the marketplace backend (Sub-project B). Thin hooks over
// the `marketplace` schema RPCs + Storage + the Tauri verified-install command,
// following the codebase's useState/useEffect data-hook convention (see
// modules/pm/lib/useDashboardPhotos.ts), NOT React Query.
//
// Install flow: install_plugin (records the install, returns verify metadata) ->
// mint a short-lived Storage signed URL for the content-addressed bundle -> fetch
// the marketplace signing public key -> invoke the Rust `install_plugin_bundle`
// command, which verifies sha256 + Ed25519 signature before unpacking.

import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { installBundle, type InstallMetaRow } from "./installBundle";
import { useSupabaseClient, useUser } from "@helios/auth";
import type { PluginManifest } from "@helios/plugin-sdk";
import { isMarketplaceDemo, demoList, demoSubscribe, demoInstall, demoUninstall } from "./demoStore";
import { purgePluginStorage } from "../runtime/pluginStorage";

const SCHEMA = "marketplace";
const BUNDLE_BUCKET = "plugins";
const SIGNED_URL_TTL = 120; // seconds — only needs to outlive a single download

// DEV-ONLY: when the demo flag is on, the hooks serve in-memory fixtures instead
// of the (not-yet-deployed) marketplace backend. Evaluated once at load; OFF by
// default so production behavior is unchanged. See demoStore.ts.
const DEMO = isMarketplaceDemo();

/** One discoverable plugin (newest approved version) + the caller's install state. */
export interface AvailablePlugin {
  id: string;
  name: string;
  subteam: string | null;
  isRecommended: boolean;
  version: string;
  manifest: PluginManifest;
  permissions: string[];
  installedVersion: string | null;
  publishedAt: string;
  /** Set on Installed rows only: this install is a reviewer's test-drive of an
   *  UNAPPROVED build, not a normal install. */
  isPreview?: boolean;
  /** Set on Installed rows only: the review state of the INSTALLED version, so a
   *  yanked or still-pending install can say so. */
  installedStatus?: string | null;
  /** Set on Installed rows only: an approved version of this plugin is on offer,
   *  so a preview can be swapped for the real thing. */
  hasApprovedVersion?: boolean;
}

/** Raw row shape from `marketplace.list_available_plugins()` (snake_case). */
interface AvailableRow {
  id: string;
  name: string;
  subteam: string | null;
  is_recommended: boolean;
  version: string;
  manifest: PluginManifest;
  permissions: string[] | null;
  installed_version: string | null;
  published_at: string;
}

function toAvailable(r: AvailableRow): AvailablePlugin {
  return {
    id: r.id,
    name: r.name,
    subteam: r.subteam,
    isRecommended: r.is_recommended,
    version: r.version,
    manifest: r.manifest,
    permissions: r.permissions ?? [],
    installedVersion: r.installed_version,
    publishedAt: r.published_at,
  };
}

const EMPTY: AvailablePlugin[] = [];

/** All discoverable (approved) plugins + whether the caller has each installed. */
export function useAvailablePlugins(): {
  loading: boolean;
  error: string | null;
  plugins: AvailablePlugin[];
  refetch: () => void;
} {
  const client = useSupabaseClient();
  const [plugins, setPlugins] = useState<AvailablePlugin[]>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const refetch = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    if (DEMO) {
      const sync = () => setPlugins(demoList());
      sync();
      setLoading(false);
      setError(null);
      return demoSubscribe(sync);
    }
    let active = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const res = await client.schema(SCHEMA).rpc("list_available_plugins");
        if (!active) return;
        if (res.error) {
          setError(res.error.message);
          setPlugins(EMPTY);
          return;
        }
        const rows = (res.data ?? []) as AvailableRow[];
        setPlugins(rows.map(toAvailable));
      } catch (e) {
        if (!active) return;
        setError(e instanceof Error ? e.message : String(e));
        setPlugins(EMPTY);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [client, reloadKey]);

  return { loading, error, plugins, refetch };
}

/** Raw row shape from `marketplace.my_installed_plugins()`. */
export interface MyInstallRow {
  plugin_id: string;
  name: string;
  subteam: string | null;
  is_recommended: boolean;
  installed_version: string;
  is_preview: boolean;
  installed_at: string;
  review_status: string | null;
  manifest: PluginManifest | null;
  permissions: string[] | null;
  latest_version: string | null;
}

/**
 * The caller's installs, as Installed rows.
 *
 * Built from the caller's OWN install rows (`my_installed_plugins`), not by
 * filtering the Browse list. Browse only carries plugins that still have an
 * approved version, so yanking a plugin's only release used to make it vanish
 * from Installed while it was still unpacked on disk, with no way to open or
 * uninstall it. Where the plugin IS still offered, the Browse row supplies the
 * newest approved version so "Update" keeps working.
 *
 * `rows === null` means the install list could not be fetched (e.g. a backend
 * without the RPC yet); fall back to the Browse-derived list rather than showing
 * nothing.
 */
export function mergeInstalled(
  available: AvailablePlugin[],
  rows: MyInstallRow[] | null,
): AvailablePlugin[] {
  if (rows === null) return available.filter((p) => p.installedVersion !== null);
  const byId = new Map(available.map((p) => [p.id, p]));
  return rows.map((r) => {
    const offered = byId.get(r.plugin_id);
    const manifest = r.manifest ?? offered?.manifest ?? null;
    return {
      id: r.plugin_id,
      name: r.name,
      subteam: r.subteam,
      isRecommended: r.is_recommended,
      // Newest APPROVED version, for the Update affordance. A plugin with none
      // left (all yanked) has nothing to update to.
      version: offered?.version ?? r.latest_version ?? r.installed_version,
      manifest:
        manifest ??
        ({
          format: 1,
          id: r.plugin_id,
          name: r.name,
          version: r.installed_version,
          entry: "index.html",
          sdk: "^1.0.0",
          permissions: [],
        } as PluginManifest),
      permissions: offered?.permissions ?? r.permissions ?? [],
      installedVersion: r.installed_version,
      publishedAt: offered?.publishedAt ?? r.installed_at,
      isPreview: r.is_preview,
      installedStatus: r.review_status,
      hasApprovedVersion: offered !== undefined || r.latest_version !== null,
    };
  });
}

/** The caller's install rows. `rows` is null when they could not be fetched. */
export function useMyInstalls(): {
  loading: boolean;
  rows: MyInstallRow[] | null;
  refetch: () => void;
} {
  const client = useSupabaseClient();
  const [rows, setRows] = useState<MyInstallRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const refetch = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    if (DEMO) {
      setRows(null);
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    void (async () => {
      try {
        const res = await client.schema(SCHEMA).rpc("my_installed_plugins");
        if (!active) return;
        // A failure keeps the rows from the last successful load (so previews
        // do not flicker out of Installed and Review); only if there never was
        // one does it fall back to the Browse-derived list (see mergeInstalled).
        if (!res.error) setRows((res.data ?? []) as MyInstallRow[]);
      } catch {
        /* keep the previous rows */
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [client, reloadKey]);

  return { loading, rows, refetch };
}

/** The caller's installed plugins (see `mergeInstalled`). */
export function useInstalledPlugins(): {
  loading: boolean;
  error: string | null;
  plugins: AvailablePlugin[];
  refetch: () => void;
} {
  const avail = useAvailablePlugins();
  const mine = useMyInstalls();
  const installed = useMemo(() => mergeInstalled(avail.plugins, mine.rows), [avail.plugins, mine.rows]);
  const { refetch: refetchAvail } = avail;
  const { refetch: refetchMine } = mine;
  const refetch = useCallback(() => {
    refetchAvail();
    refetchMine();
  }, [refetchAvail, refetchMine]);
  return { loading: avail.loading || mine.loading, error: avail.error, plugins: installed, refetch };
}

/** Download + verify + install a plugin's current (approved) version. */
export function useInstall(): {
  install: (plugin: Pick<AvailablePlugin, "id" | "version">) => Promise<void>;
  installing: boolean;
  error: string | null;
} {
  const client = useSupabaseClient();
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const install = useCallback(
    async (plugin: Pick<AvailablePlugin, "id" | "version">) => {
      if (DEMO) {
        demoInstall(plugin.id, plugin.version);
        return;
      }
      setInstalling(true);
      setError(null);
      try {
        // 1. Record the install + fetch verify metadata (refuses non-approved).
        const meta = await client
          .schema(SCHEMA)
          .rpc("install_plugin", { p_plugin_id: plugin.id, p_version: plugin.version });
        if (meta.error) throw new Error(meta.error.message);
        const row = ((meta.data ?? []) as InstallMetaRow[])[0];
        if (!row) throw new Error("install_plugin returned no version metadata");

        // 2-4. Signed URL -> signing key -> Rust verify + unpack. Shared with the
        //      reviewer's test-drive so both run the identical verification.
        await installBundle(client, row);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        throw e instanceof Error ? e : new Error(msg);
      } finally {
        setInstalling(false);
      }
    },
    [client],
  );

  return { install, installing, error };
}

/** Remove the caller's install, delete the local bundle cache, and erase what the
 *  add-on stored for this member. All three are what the uninstall confirmation
 *  promises; leaving the storage behind previously meant a reinstall silently
 *  resurrected old config, and the keys kept eating the plugin's 1 MB quota
 *  forever. */
export function useUninstall(): {
  uninstall: (pluginId: string, opts?: { keepData?: boolean }) => Promise<void>;
  removing: boolean;
  error: string | null;
} {
  const client = useSupabaseClient();
  const user = useUser();
  const userId = user?.id ?? null;
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const uninstall = useCallback(
    async (pluginId: string, opts?: { keepData?: boolean }) => {
      if (DEMO) {
        demoUninstall(pluginId);
        return;
      }
      setRemoving(true);
      setError(null);
      try {
        const res = await client.schema(SCHEMA).rpc("uninstall_plugin", { p_plugin_id: pluginId });
        if (res.error) throw new Error(res.error.message);
        // Best-effort local cache cleanup (ignored in a non-Tauri/test context).
        try {
          await invoke("remove_plugin_bundle", { pluginId });
        } catch {
          /* not running under Tauri */
        }
        // Erase this member's data vault for the plugin. Done last, after the
        // server-side removal succeeded, so a failed uninstall doesn't throw away
        // the settings of an add-on that is still installed.
        //
        // Removing a reviewer's TEST-DRIVE keeps it: the preview shared the plugin's
        // storage namespace with any real install the reviewer had, and throwing
        // away their settings because they reviewed an update would be a nasty
        // surprise.
        if (userId && !opts?.keepData) purgePluginStorage(userId, pluginId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        throw e instanceof Error ? e : new Error(msg);
      } finally {
        setRemoving(false);
      }
    },
    [client, userId],
  );

  return { uninstall, removing, error };
}
