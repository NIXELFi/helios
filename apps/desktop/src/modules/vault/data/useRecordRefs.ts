import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSupabaseClient } from "@helios/auth";
import { notifyVaultWarning } from "./vault-warning-events";
import type { VaultId, VersionId } from "./types";

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
    async (
      parentVersionId: VersionId,
      localPath: string,
      fileName: string,
      vaultId?: VaultId | null,
    ): Promise<void> => {
      if (!isSwFile(fileName)) return;
      try {
        const hints = await invoke<string[]>("parse_sw_refs", { path: localPath });
        await client.rpc("pdm_record_refs", {
          p_parent_version_id: parentVersionId,
          p_child_hints: hints ?? [],
        });
        // SW PDM halts on references it can't resolve; we record them as
        // unresolved — but silently was a bug (audit 2026-06-09): the user
        // discovered broken cross-references much later. Read back what the
        // RPC left unresolved and say so, distinguishing "no such file" from
        // "two files share that name" (which a re-check-in can never fix).
        if ((hints?.length ?? 0) > 0) {
          const { data: refs } = await (client.from("refs") as any)
            .select("child_path_hint, child_file_id")
            .eq("parent_version_id", parentVersionId);
          const unresolved: { hint: string; reason: "missing" | "ambiguous" }[] = [];
          for (const r of (refs ?? []) as { child_path_hint: string; child_file_id: string | null }[]) {
            if (r.child_file_id != null) continue;
            const base = r.child_path_hint.split(/[\\/]/).pop() ?? r.child_path_hint;
            // `base` is a raw filename — escape the LIKE metacharacters `_` and
            // `%` (and the escape char `\` itself) before feeding it to ilike,
            // or a name like "frame_v2.sldprt" would treat `_` as "any single
            // char" and a name containing `%` as "any run", producing false
            // ambiguous/missing classifications. With them escaped, ilike is a
            // true case-insensitive equality match as intended.
            const baseEsc = base.replace(/([\\%_])/g, "\\$1");
            let reason: "missing" | "ambiguous" = "missing";
            if (vaultId) {
              const { count } = await (client.from("files") as any)
                .select("id", { count: "exact", head: true })
                .eq("vault_id", vaultId)
                .is("deleted_at", null)
                .ilike("name", baseEsc); // escaped → case-insensitive equality
              if ((count ?? 0) > 1) reason = "ambiguous";
            }
            unresolved.push({ hint: base, reason });
          }
          if (unresolved.length > 0) {
            const ambiguous = unresolved.filter((u) => u.reason === "ambiguous");
            notifyVaultWarning({
              title: `${fileName}: ${unresolved.length} reference${unresolved.length === 1 ? "" : "s"} unresolved`,
              detail:
                unresolved.map((u) => u.hint).join(", ") +
                (ambiguous.length > 0
                  ? ` — ${ambiguous.map((u) => `"${u.hint}" matches multiple vault files (rename one to disambiguate)`).join("; ")}`
                  : " — not found in this vault"),
            });
          }
        }
      } catch (e) {
        console.warn(`[vault] recording refs for ${fileName} failed (non-fatal):`, e);
      }
    },
    [client],
  );
  return { run };
}
