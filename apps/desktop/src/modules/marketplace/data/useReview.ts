// Reviewer-side data layer (Sub-project D). Hooks over the marketplace review
// RPCs: the pending-version queue and the approve/reject transition. Gated in the
// UI on `useMyCapabilities().can("marketplace.review")`; the RPCs re-check the
// capability server-side, so these are a convenience, not the security boundary.

import { useCallback, useEffect, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import type { PluginManifest } from "@helios/plugin-sdk";

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
