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

/** Raw row from `marketplace.install_plugin()` — everything needed to download +
 *  verify the bundle on the Rust side. */
interface InstallMetaRow {
  plugin_id: string;
  version: string;
  manifest: PluginManifest;
  bundle_sha256: string;
  bundle_bytes: number;
  signature: string;
  sig_alg: string;
  signing_key_id: string;
}

interface PublicKeyRow {
  key_id: string;
  public_key: string;
  alg: string;
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

/** The subset the caller has installed. */
export function useInstalledPlugins(): {
  loading: boolean;
  error: string | null;
  plugins: AvailablePlugin[];
  refetch: () => void;
} {
  const { loading, error, plugins, refetch } = useAvailablePlugins();
  const installed = useMemo(() => plugins.filter((p) => p.installedVersion !== null), [plugins]);
  return { loading, error, plugins: installed, refetch };
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

        // 2. Short-lived signed URL for the content-addressed bundle.
        const signed = await client.storage
          .from(BUNDLE_BUCKET)
          .createSignedUrl(row.bundle_sha256, SIGNED_URL_TTL);
        if (signed.error || !signed.data?.signedUrl) {
          throw new Error(signed.error?.message ?? "could not sign bundle URL");
        }

        // 3. Marketplace public key for client-side signature verification.
        const pk = await client.schema(SCHEMA).rpc("signing_public_key");
        if (pk.error) throw new Error(pk.error.message);
        const keyRow = ((pk.data ?? []) as PublicKeyRow[])[0];
        if (!keyRow) throw new Error("no marketplace signing key available");

        // 4. Hand off to Rust: verifies sha256 + signature, then unpacks. Tauri
        //    maps these camelCase args to the command's snake_case params.
        await invoke("install_plugin_bundle", {
          pluginId: row.plugin_id,
          version: row.version,
          signedUrl: signed.data.signedUrl,
          expectedSha256: row.bundle_sha256,
          bundleBytes: row.bundle_bytes,
          signature: row.signature,
          sigAlg: row.sig_alg,
          publicKey: keyRow.public_key,
          // H1: the approved/consented permission set (from install_plugin's
          // manifest). The Rust side refuses to install a bundle whose own
          // manifest.json declares any permission not in this set.
          approvedPermissions: row.manifest.permissions ?? [],
        });
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
  uninstall: (pluginId: string) => Promise<void>;
  removing: boolean;
  error: string | null;
} {
  const client = useSupabaseClient();
  const user = useUser();
  const userId = user?.id ?? null;
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const uninstall = useCallback(
    async (pluginId: string) => {
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
        if (userId) purgePluginStorage(userId, pluginId);
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
