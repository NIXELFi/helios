import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSupabaseClient } from "@helios/auth";
import { notifyVaultWarning } from "./vault-warning-events";
import type { SwProperty, VersionId } from "./types";

// File types whose custom properties we read for the data card.
const SW_EXTS = [".sldprt", ".sldasm", ".slddrw"];
function isSwFile(name: string): boolean {
  const l = name.toLowerCase();
  return SW_EXTS.some((e) => l.endsWith(e));
}

/**
 * Parse a SolidWorks file's custom properties (via the `parse_sw_properties`
 * Tauri command) and store them on the given version (`pdm_set_version_properties`).
 * Used at check-in AND for lazy backfill of existing versions from their local
 * working copy. Returns the parsed properties (for immediate display) or null.
 *
 * Best-effort: non-SolidWorks files are skipped, and any failure (parse miss,
 * RPC error, no Tauri runtime) is swallowed — properties are auxiliary metadata
 * and must never break the surrounding flow.
 */
export function useRecordProperties() {
  const client = useSupabaseClient();
  const run = useCallback(
    async (
      versionId: VersionId,
      localPath: string,
      fileName: string,
      // Check-in passes true: a parse failure there means the data card was
      // NOT captured for the new version and the user should know. The lazy
      // backfill path (viewing an old version) stays silent — a warning per
      // panel-open would be noise.
      surfaceErrors = false,
    ): Promise<SwProperty[] | null> => {
      if (!isSwFile(fileName)) return null;
      try {
        const props = await invoke<SwProperty[]>("parse_sw_properties", { path: localPath });
        if (props && props.length > 0) {
          await client.rpc("pdm_set_version_properties", {
            p_version_id: versionId,
            p_properties: props,
          });
        }
        return props ?? null;
      } catch (e) {
        console.warn(`[vault] reading properties for ${fileName} failed (non-fatal):`, e);
        if (surfaceErrors) {
          notifyVaultWarning({
            title: `${fileName}: data card not captured`,
            detail: `Couldn't read the file's custom properties (${e instanceof Error ? e.message : String(e)}). The version checked in fine; its data card is empty.`,
          });
        }
        return null;
      }
    },
    [client],
  );
  return { run };
}
