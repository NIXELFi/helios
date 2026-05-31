import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSupabaseClient } from "@helios/auth";
import type { SwProperty, Version } from "./types";

const SW_EXTS = [".sldprt", ".sldasm", ".slddrw"];
const isSwFile = (n: string) => SW_EXTS.some((e) => n.toLowerCase().endsWith(e));

/** Parse properties from a file on disk. Returns null if the file can't be read
 *  (not present), or the property list (possibly empty) if it was read. The
 *  null-vs-[] distinction lets the caller tell "not downloaded" from
 *  "downloaded but has no custom properties". */
async function parseLocal(path: string): Promise<SwProperty[] | null> {
  try {
    return (await invoke<SwProperty[]>("parse_sw_properties", { path })) ?? [];
  } catch {
    return null; // read failed → file isn't on disk
  }
}

export interface ResolvedProperties {
  props: SwProperty[] | null;
  loading: boolean;
  /** True when the file isn't downloaded locally and no properties are cached
   *  server-side — so we can't read them WITHOUT downloading (which we won't
   *  force). The UI shows a "download to read" hint. */
  notDownloaded: boolean;
}

/**
 * Resolve a version's SolidWorks custom properties for display WITHOUT ever
 * downloading the file:
 *   1. use the version's stored `properties` if cached server-side (the
 *      Supabase path — populated at check-in or by anyone who had it local);
 *   2. else parse the LOCAL working copy if it's on disk;
 *   3. else report `notDownloaded` (the card shows a hint instead of forcing a
 *      multi-MB download).
 * A successful local parse is cached back to the backend (best-effort) so other
 * users / future views get it from Supabase without needing the file locally.
 */
export function useFileProperties(
  version: Version | null,
  localPath: string | null,
  fileName: string | null,
): ResolvedProperties {
  const client = useSupabaseClient();
  const [state, setState] = useState<ResolvedProperties>({
    props: version?.properties ?? null,
    loading: false,
    notDownloaded: false,
  });

  useEffect(() => {
    let alive = true;
    if (!version || !fileName || !isSwFile(fileName)) {
      setState({ props: version?.properties ?? null, loading: false, notDownloaded: false });
      return;
    }
    if (version.properties && version.properties.length > 0) {
      setState({ props: version.properties, loading: false, notDownloaded: false });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    (async () => {
      const local = localPath ? await parseLocal(localPath) : null;
      if (!alive) return;
      if (local === null) {
        // Not on disk (and nothing cached) → don't download; tell the user.
        setState({ props: null, loading: false, notDownloaded: true });
        return;
      }
      setState({ props: local, loading: false, notDownloaded: false });
      if (local.length > 0) {
        // Cache to the backend so future views (and other users) get these from
        // Supabase without needing the file locally. Best-effort: a missing RPC
        // / lacking permission must never affect display.
        client.rpc("pdm_set_version_properties", { p_version_id: version.id, p_properties: local })
          .then(() => {}, () => {});
      }
    })();
    return () => { alive = false; };
    // Re-resolve only when the selected version changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version?.id]);

  return state;
}
