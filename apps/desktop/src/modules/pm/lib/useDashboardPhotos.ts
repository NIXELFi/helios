// Dashboard "Photos" widget data layer.
//
// Reads pinned photos for a dashboard scope (a subteam, or the all-team
// dashboard when subteamId is null) from `pm.dashboard_photos`, resolves a
// short-lived signed URL for each (the `dashboard-photos` bucket is private),
// and — for users with the `pm.manage_dashboard` capability in this scope —
// exposes upload/remove mutations. Mirrors the read-pattern of useGcalEvents
// (active-flag cleanup, loading/error states) and the pm-schema access style
// (`client.schema("pm")`).

import { useCallback, useEffect, useState } from "react";
import { useSupabaseClient } from "@helios/auth";
import { usePmStore } from "@pm/lib/pmStore";

const BUCKET = "dashboard-photos";
const SIGNED_URL_TTL = 3600; // seconds

// Raw row shape selected from pm.dashboard_photos.
interface PhotoRow {
  id: string;
  subteam_id: string | null;
  storage_path: string;
  caption: string | null;
  sort_order: number | null;
  created_by: string | null;
  created_at: string;
}

// Client-facing shape: a row plus the resolved (possibly null) signed URL.
export interface DashboardPhoto {
  id: string;
  storagePath: string;
  caption: string | null;
  sortOrder: number;
  url: string | null;
}

export interface UseDashboardPhotosResult {
  loading: boolean;
  error: string | null;
  photos: DashboardPhoto[];
  canManage: boolean;
  uploading: boolean;
  upload: (file: File) => Promise<void>;
  remove: (photo: DashboardPhoto) => Promise<void>;
}

const EMPTY_PHOTOS: DashboardPhoto[] = [];

function extOf(file: File): string {
  // Prefer the filename extension; fall back to the mime subtype; default jpg.
  const fromName = file.name.includes(".") ? file.name.split(".").pop() : "";
  const cleaned = (fromName ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (cleaned) return cleaned;
  const sub = file.type.split("/")[1]?.toLowerCase().replace(/[^a-z0-9]/g, "");
  return sub || "jpg";
}

function newUuid(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // fall through
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function useDashboardPhotos(subteamId: string | null): UseDashboardPhotosResult {
  const client = useSupabaseClient();
  const currentUserId = usePmStore((s) => s.currentUserId);

  const [photos, setPhotos] = useState<DashboardPhoto[]>(EMPTY_PHOTOS);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumping this triggers a refetch (after a successful upload/remove).
  const [reloadKey, setReloadKey] = useState(0);

  const refetch = useCallback(() => setReloadKey((k) => k + 1), []);

  // --- Load rows + signed URLs for the scope -------------------------------
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        let q = client
          .schema("pm")
          .from("dashboard_photos")
          .select("id,subteam_id,storage_path,caption,sort_order,created_by,created_at")
          .order("sort_order", { ascending: true })
          .order("created_at", { ascending: true });
        q = subteamId === null ? q.is("subteam_id", null) : q.eq("subteam_id", subteamId);

        const res = await q;
        if (!active) return;
        if (res.error) {
          setError(res.error.message);
          setPhotos(EMPTY_PHOTOS);
          return;
        }
        const rows = (res.data ?? []) as PhotoRow[];
        if (rows.length === 0) {
          setPhotos(EMPTY_PHOTOS);
          return;
        }

        // Batch-resolve signed URLs (bucket is private). If signing fails as a
        // whole, fall back to per-row nulls so the grid still renders.
        const paths = rows.map((r) => r.storage_path);
        const urlByPath = new Map<string, string | null>();
        try {
          const signed = await client.storage.from(BUCKET).createSignedUrls(paths, SIGNED_URL_TTL);
          if (!signed.error && Array.isArray(signed.data)) {
            for (const s of signed.data) {
              if (s.path) urlByPath.set(s.path, s.signedUrl ?? null);
            }
          }
        } catch {
          // leave urlByPath empty → every url resolves to null below
        }
        if (!active) return;

        const mapped: DashboardPhoto[] = rows.map((r) => ({
          id: r.id,
          storagePath: r.storage_path,
          caption: r.caption,
          sortOrder: typeof r.sort_order === "number" ? r.sort_order : 0,
          url: urlByPath.get(r.storage_path) ?? null,
        }));
        setPhotos(mapped);
      } catch (e) {
        if (!active) return;
        setError(e instanceof Error ? e.message : String(e));
        setPhotos(EMPTY_PHOTOS);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [client, subteamId, reloadKey]);

  // --- Capability check (manage-dashboard for this scope) -------------------
  useEffect(() => {
    let active = true;
    setCanManage(false);
    if (!currentUserId) return;
    void (async () => {
      try {
        const res = await client.schema("pm").rpc("has_capability", {
          uid: currentUserId,
          cap: "pm.manage_dashboard",
          stid: subteamId,
        });
        if (!active) return;
        if (!res.error) setCanManage(res.data === true);
      } catch {
        if (active) setCanManage(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [client, currentUserId, subteamId]);

  // --- Mutations -----------------------------------------------------------
  const upload = useCallback(
    async (file: File) => {
      setUploading(true);
      setError(null);
      try {
        const path = `${subteamId ?? "all"}/${newUuid()}.${extOf(file)}`;
        const up = await client.storage.from(BUCKET).upload(path, file);
        if (up.error) throw new Error(up.error.message);

        const ins = await client
          .schema("pm")
          .from("dashboard_photos")
          .insert({
            subteam_id: subteamId,
            storage_path: path,
            caption: null,
            sort_order: photos.length,
            created_by: currentUserId || null,
          });
        if (ins.error) {
          // Best-effort: don't orphan the uploaded object if the row insert fails.
          try {
            await client.storage.from(BUCKET).remove([path]);
          } catch {
            // ignore cleanup failure
          }
          throw new Error(ins.error.message);
        }
        refetch();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setUploading(false);
      }
    },
    [client, subteamId, currentUserId, photos.length, refetch],
  );

  const remove = useCallback(
    async (photo: DashboardPhoto) => {
      setError(null);
      try {
        // Remove the storage object first (best-effort), then the row.
        try {
          await client.storage.from(BUCKET).remove([photo.storagePath]);
        } catch {
          // ignore — still drop the row so the gallery isn't stuck
        }
        const del = await client.schema("pm").from("dashboard_photos").delete().eq("id", photo.id);
        if (del.error) throw new Error(del.error.message);
        refetch();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [client, refetch],
  );

  return { loading, error, photos, canManage, uploading, upload, remove };
}
