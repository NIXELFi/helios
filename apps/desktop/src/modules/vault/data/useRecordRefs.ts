import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSupabaseClient } from "@helios/auth";
import type { VersionId } from "./types";

// File types that carry SolidWorks references worth parsing.
const SW_REF_EXTS = [".sldasm", ".slddrw", ".sldprt"];

function isSwFile(name: string): boolean {
  const lower = name.toLowerCase();
  return SW_REF_EXTS.some((e) => lower.endsWith(e));
}

/**
 * After a successful check-in, parse the file's child references (via the
 * `parse_sw_refs` Tauri command) and persist them with `pdm_record_refs`.
 * Best-effort: references are auxiliary metadata, so any failure (parse miss,
 * RPC error, non-Tauri runtime) is swallowed — it must never fail the check-in
 * the user just did. Non-SolidWorks files are skipped without a round-trip.
 */
export function useRecordRefs() {
  const client = useSupabaseClient();
  const run = useCallback(
    async (parentVersionId: VersionId, localPath: string, fileName: string): Promise<void> => {
      if (!isSwFile(fileName)) return;
      try {
        const hints = await invoke<string[]>("parse_sw_refs", { path: localPath });
        await client.rpc("pdm_record_refs", {
          p_parent_version_id: parentVersionId,
          p_child_hints: hints ?? [],
        });
      } catch (e) {
        console.warn(`[vault] recording refs for ${fileName} failed (non-fatal):`, e);
      }
    },
    [client],
  );
  return { run };
}
