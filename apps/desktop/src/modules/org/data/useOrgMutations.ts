import { useCallback } from "react";
import { useSupabaseClient } from "@helios/auth";

// Thin wrappers over the guarded pm.* admin RPCs. Authorization (grant-subset,
// owner-protection, etc.) is enforced SERVER-SIDE; these just surface the result
// + a friendly error string. All RPCs live in the `pm` schema.

type Result = { ok: boolean; error: string | null };

function messageOf(err: { message?: string } | null): string {
  // pm RPCs raise plain messages ("not authorized to grant roles in this
  // subteam", "cannot remove the last owner", …) — surface them directly.
  return err?.message ?? "Something went wrong.";
}

export function useOrgMutations() {
  const client = useSupabaseClient();

  const grantRole = useCallback(
    async (target: string, roleKey: string, subteamId: string | null): Promise<Result> => {
      const { error } = await client
        .schema("pm")
        .rpc("grant_role", { p_target: target, p_role_key: roleKey, p_subteam_id: subteamId });
      return error ? { ok: false, error: messageOf(error) } : { ok: true, error: null };
    },
    [client],
  );

  const revokeRole = useCallback(
    async (target: string, roleKey: string, subteamId: string | null): Promise<Result> => {
      const { error } = await client
        .schema("pm")
        .rpc("revoke_role", { p_target: target, p_role_key: roleKey, p_subteam_id: subteamId });
      return error ? { ok: false, error: messageOf(error) } : { ok: true, error: null };
    },
    [client],
  );

  const setProjectSubteam = useCallback(
    async (projectId: string, subteamId: string, present: boolean): Promise<Result> => {
      const { error } = await client
        .schema("pm")
        .rpc("set_project_subteam", { p_project_id: projectId, p_subteam_id: subteamId, p_present: present });
      return error ? { ok: false, error: messageOf(error) } : { ok: true, error: null };
    },
    [client],
  );

  const upsertRole = useCallback(
    async (
      key: string,
      label: string,
      tag: string,
      scope: "org" | "subteam",
      capabilities: string[],
    ): Promise<Result> => {
      const { error } = await client.schema("pm").rpc("upsert_role", {
        p_key: key,
        p_label: label,
        p_tag: tag,
        p_scope: scope,
        p_capabilities: capabilities,
      });
      return error ? { ok: false, error: messageOf(error) } : { ok: true, error: null };
    },
    [client],
  );

  const deleteRole = useCallback(
    async (key: string): Promise<Result> => {
      const { error } = await client.schema("pm").rpc("delete_role", { p_key: key });
      return error ? { ok: false, error: messageOf(error) } : { ok: true, error: null };
    },
    [client],
  );

  return { grantRole, revokeRole, setProjectSubteam, upsertRole, deleteRole };
}
