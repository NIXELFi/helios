// Author-side data layer: every plugin the caller can publish to, with every
// version and its review state, plus the three management actions. The RPCs
// re-check who may do what server-side (withdraw / yank: the version's author or
// a reviewer for the subteam; recommend: a reviewer), so the UI gating that
// mirrors those rules is a convenience, never the boundary.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { PluginManifest } from "@helios/plugin-sdk";

const SCHEMA = "marketplace";

/** Raw row from `marketplace.my_published_plugins()`: one per VERSION. */
export interface MyVersionRow {
  plugin_id: string;
  name: string;
  subteam: string | null;
  is_recommended: boolean;
  latest_version: string | null;
  version: string;
  manifest: PluginManifest;
  permissions: string[] | null;
  review_status: string;
  review_notes: string | null;
  reviewed_at: string | null;
  bundle_bytes: number;
  published_by: string;
  published_at: string;
}

export type ReviewStatus = "pending" | "approved" | "rejected" | "withdrawn" | "yanked";

export interface MyVersion {
  version: string;
  status: ReviewStatus;
  reviewNotes: string | null;
  reviewedAt: string | null;
  bundleBytes: number;
  publishedBy: string;
  publishedAt: string;
  permissions: string[];
}

export interface MyPlugin {
  id: string;
  name: string;
  subteam: string | null;
  isRecommended: boolean;
  latestVersion: string | null;
  /** Newest first. */
  versions: MyVersion[];
}

/** Group per-version rows under their plugin, versions newest first. Pure. */
export function groupMyPlugins(rows: MyVersionRow[]): MyPlugin[] {
  const byId = new Map<string, MyPlugin>();
  for (const r of rows) {
    let p = byId.get(r.plugin_id);
    if (!p) {
      p = {
        id: r.plugin_id,
        name: r.name,
        subteam: r.subteam,
        isRecommended: r.is_recommended,
        latestVersion: r.latest_version,
        versions: [],
      };
      byId.set(r.plugin_id, p);
    }
    p.versions.push({
      version: r.version,
      status: r.review_status as ReviewStatus,
      reviewNotes: r.review_notes,
      reviewedAt: r.reviewed_at,
      bundleBytes: r.bundle_bytes,
      publishedBy: r.published_by,
      publishedAt: r.published_at,
      permissions: r.permissions ?? [],
    });
  }
  const out = [...byId.values()];
  for (const p of out) p.versions.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function useMyPlugins(): {
  loading: boolean;
  error: string | null;
  plugins: MyPlugin[];
  refetch: () => void;
  withdraw: (pluginId: string, version: string) => Promise<void>;
  yank: (pluginId: string, version: string, reason?: string) => Promise<void>;
  setRecommended: (pluginId: string, value: boolean) => Promise<void>;
  /** `${pluginId}@${version}` (or the plugin id, for recommend) while a call runs. */
  pending: string | null;
  actionError: string | null;
} {
  const client = useSupabaseClient();
  const [rows, setRows] = useState<MyVersionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Optimistic recommend overrides, cleared once the refetch lands.
  const [recommendOverride, setRecommendOverride] = useState<Record<string, boolean>>({});

  const refetch = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void (async () => {
      try {
        const res = await client.schema(SCHEMA).rpc("my_published_plugins");
        if (!active) return;
        if (res.error) {
          setError(res.error.message);
          setRows([]);
          return;
        }
        setError(null);
        setRows((res.data ?? []) as MyVersionRow[]);
        setRecommendOverride({});
      } catch (e) {
        if (!active) return;
        setError(e instanceof Error ? e.message : String(e));
        setRows([]);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [client, reloadKey]);

  const plugins = useMemo(
    () =>
      groupMyPlugins(rows).map((p) =>
        p.id in recommendOverride ? { ...p, isRecommended: recommendOverride[p.id]! } : p,
      ),
    [rows, recommendOverride],
  );

  const run = useCallback(
    async (key: string, fn: string, args: Record<string, unknown>) => {
      setPending(key);
      setActionError(null);
      try {
        const res = await client.schema(SCHEMA).rpc(fn, args);
        if (res.error) throw new Error(res.error.message);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setActionError(msg);
        throw e instanceof Error ? e : new Error(msg);
      } finally {
        setPending(null);
      }
    },
    [client],
  );

  const withdraw = useCallback(
    async (pluginId: string, version: string) => {
      await run(`${pluginId}@${version}`, "withdraw_plugin_version", {
        p_plugin_id: pluginId,
        p_version: version,
      });
      refetch();
    },
    [run, refetch],
  );

  const yank = useCallback(
    async (pluginId: string, version: string, reason?: string) => {
      await run(`${pluginId}@${version}`, "yank_plugin_version", {
        p_plugin_id: pluginId,
        p_version: version,
        p_reason: reason?.trim() ? reason.trim() : null,
      });
      refetch();
    },
    [run, refetch],
  );

  const setRecommended = useCallback(
    async (pluginId: string, value: boolean) => {
      setRecommendOverride((o) => ({ ...o, [pluginId]: value }));
      try {
        await run(pluginId, "set_plugin_recommended", { p_plugin_id: pluginId, p_value: value });
        refetch();
      } catch (e) {
        // Roll the optimistic flip back.
        setRecommendOverride((o) => {
          const next = { ...o };
          delete next[pluginId];
          return next;
        });
        throw e;
      }
    },
    [run, refetch],
  );

  return { loading, error, plugins, refetch, withdraw, yank, setRecommended, pending, actionError };
}
