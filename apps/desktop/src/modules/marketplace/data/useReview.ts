// Reviewer-side data layer (Sub-project D). Hooks over the marketplace review
// RPCs: the pending-version queue and the approve/reject transition. Gated in the
// UI on `useMyCapabilities().can("marketplace.review")`; the RPCs re-check the
// capability server-side, so these are a convenience, not the security boundary.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSupabaseClient } from "@helios/auth";
import type { PluginManifest } from "@helios/plugin-sdk";
import { preflight, reportsDisagree, type PreflightReport } from "../publish/preflight";
import { installBundle, signedBundleUrl, type InstallMetaRow } from "./installBundle";

const SCHEMA = "marketplace";

export interface ReviewItem {
  pluginId: string;
  name: string;
  subteam: string | null;
  version: string;
  manifest: PluginManifest;
  permissions: string[];
  reviewReport: unknown | null;
  bundleSha256: string;
  bundleBytes: number;
  publishedBy: string;
  publishedAt: string;
}

interface ReviewQueueRow {
  plugin_id: string;
  name: string;
  subteam: string | null;
  version: string;
  manifest: PluginManifest;
  permissions: string[] | null;
  review_report: unknown | null;
  bundle_sha256: string;
  bundle_bytes: number;
  published_by: string;
  published_at: string;
}

function toItem(r: ReviewQueueRow): ReviewItem {
  return {
    pluginId: r.plugin_id,
    name: r.name,
    subteam: r.subteam,
    version: r.version,
    manifest: r.manifest,
    permissions: r.permissions ?? [],
    reviewReport: r.review_report,
    bundleSha256: r.bundle_sha256,
    bundleBytes: r.bundle_bytes,
    publishedBy: r.published_by,
    publishedAt: r.published_at,
  };
}

const EMPTY: ReviewItem[] = [];

/** Pending versions the caller is allowed to review. */
export function useReviewQueue(): {
  loading: boolean;
  error: string | null;
  queue: ReviewItem[];
  refetch: () => void;
} {
  const client = useSupabaseClient();
  const [queue, setQueue] = useState<ReviewItem[]>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const refetch = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const res = await client.schema(SCHEMA).rpc("review_queue");
        if (!active) return;
        if (res.error) {
          setError(res.error.message);
          setQueue(EMPTY);
          return;
        }
        setQueue(((res.data ?? []) as ReviewQueueRow[]).map(toItem));
      } catch (e) {
        if (!active) return;
        setError(e instanceof Error ? e.message : String(e));
        setQueue(EMPTY);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [client, reloadKey]);

  return { loading, error, queue, refetch };
}

export type ReviewDecision = "approved" | "rejected";

/** Approve or reject a pending version, optionally attaching scan notes/report. */
export function useReviewVersion(): {
  review: (args: {
    pluginId: string;
    version: string;
    decision: ReviewDecision;
    notes?: string;
    report?: unknown;
  }) => Promise<void>;
  reviewing: boolean;
  error: string | null;
} {
  const client = useSupabaseClient();
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const review = useCallback(
    async (args: {
      pluginId: string;
      version: string;
      decision: ReviewDecision;
      notes?: string;
      report?: unknown;
    }) => {
      setReviewing(true);
      setError(null);
      try {
        const res = await client.schema(SCHEMA).rpc("review_plugin_version", {
          p_plugin_id: args.pluginId,
          p_version: args.version,
          p_decision: args.decision,
          p_notes: args.notes ?? null,
          p_report: args.report ?? null,
        });
        if (res.error) throw new Error(res.error.message);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        throw e instanceof Error ? e : new Error(msg);
      } finally {
        setReviewing(false);
      }
    },
    [client],
  );

  return { review, reviewing, error };
}

// ---------------------------------------------------------------------------
// Reviewer-side additions for the in-app Review tab.
// ---------------------------------------------------------------------------

/** Re-run the compliance scan against the bytes ACTUALLY in Storage.
 *
 *  The `review_report` submitted alongside a version is author-supplied: a client
 *  can call the publish RPC directly with any report it likes. So the reviewer's
 *  copy is regenerated from the uploaded bundle, and `disagrees` flags the case
 *  where the two differ — not proof of anything by itself (an older client would
 *  also differ), but the first thing worth a second look. */
export function useReviewInspect(): {
  inspect: (item: ReviewItem) => Promise<void>;
  reports: Record<string, { report: PreflightReport; disagrees: boolean }>;
  inspecting: string | null;
  error: string | null;
} {
  const client = useSupabaseClient();
  const [reports, setReports] = useState<Record<string, { report: PreflightReport; disagrees: boolean }>>({});
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const inspect = useCallback(
    async (item: ReviewItem) => {
      const key = `${item.pluginId}@${item.version}`;
      setInspecting(key);
      setError(null);
      try {
        const signedUrl = await signedBundleUrl(client, item.bundleSha256);
        const inspected = (await invoke("inspect_plugin_bundle", {
          signedUrl,
          expectedSha256: item.bundleSha256,
          bundleBytes: item.bundleBytes,
        })) as { manifest: unknown; texts: Record<string, string> };

        // Scan the bundle's OWN manifest, not the separately-submitted DB copy:
        // a drift between the two is exactly what this is here to catch.
        const report = preflight(inspected.texts, inspected.manifest);
        setReports((r) => ({
          ...r,
          [key]: { report, disagrees: reportsDisagree(item.reviewReport, report) },
        }));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setInspecting(null);
      }
    },
    [client],
  );

  return { inspect, reports, inspecting, error };
}

/** Install a PENDING version locally so a reviewer can actually run it before
 *  deciding. Goes through `install_plugin_for_review` — a separate RPC, so the
 *  approved-only rule in `install_plugin` stays unconditional — and the install
 *  is recorded as a preview so it never reads as "installed" in Browse. */
export function useReviewPreview(): {
  preview: (item: ReviewItem) => Promise<void>;
  previewing: string | null;
  error: string | null;
} {
  const client = useSupabaseClient();
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const preview = useCallback(
    async (item: ReviewItem) => {
      const key = `${item.pluginId}@${item.version}`;
      setPreviewing(key);
      setError(null);
      try {
        const meta = await client.schema(SCHEMA).rpc("install_plugin_for_review", {
          p_plugin_id: item.pluginId,
          p_version: item.version,
        });
        if (meta.error) throw new Error(meta.error.message);
        const row = ((meta.data ?? []) as InstallMetaRow[])[0];
        if (!row) throw new Error("install_plugin_for_review returned no version metadata");
        await installBundle(client, row);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        throw e instanceof Error ? e : new Error(msg);
      } finally {
        setPreviewing(null);
      }
    },
    [client],
  );

  return { preview, previewing, error };
}
