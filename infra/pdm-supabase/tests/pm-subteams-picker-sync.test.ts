import { describe, expect, it } from "vitest";
import { serviceClient } from "./setup.js";

/**
 * 20260721000200: the AFTER trigger on pm.subteams mirrors registry changes
 * into pdm.subteams (the signup picker's legacy half) BY NAME — including
 * DIRECT table DML, which is how the PM module's subteam editor writes
 * (pm/lib/mutations.ts), not just the pm.create/update/delete_subteam RPCs.
 * Before this, a renamed or deleted registry subteam left its old name on
 * offer to new signups via the stale pdm row.
 */

describe("pm.subteams → pdm.subteams signup-picker sync trigger", () => {
  it("mirrors insert, follows a rename, and removes on delete — via direct DML", async () => {
    const svc = serviceClient();
    const pm = svc.schema("pm");
    const stamp = Date.now();
    const name = `SyncTest-${stamp}`;

    const { data: st, error: insErr } = await pm
      .from("subteams")
      .insert({ name, code: `S${stamp % 1000}`, slug: `sync-${stamp}` })
      .select()
      .single();
    expect(insErr).toBeNull();
    try {
      // Insert mirrored into the picker's pdm half.
      let { data: mirrored } = await svc.from("subteams").select("id").eq("name", name);
      expect(mirrored).toHaveLength(1);

      // Rename follows; the stale old name is gone from the picker.
      const renamed = `${name}-Renamed`;
      const { error: updErr } = await pm.from("subteams").update({ name: renamed }).eq("id", st!.id);
      expect(updErr).toBeNull();
      ({ data: mirrored } = await svc.from("subteams").select("id").eq("name", renamed));
      expect(mirrored).toHaveLength(1);
      const { data: stale } = await svc.from("subteams").select("id").eq("name", name);
      expect(stale).toHaveLength(0);

      // Delete removes the name from the picker.
      const { error: delErr } = await pm.from("subteams").delete().eq("id", st!.id);
      expect(delErr).toBeNull();
      const { data: gone } = await svc.from("subteams").select("id").eq("name", renamed);
      expect(gone).toHaveLength(0);
    } finally {
      // Belt-and-braces: never leave registry/picker rows for other suites.
      await pm.from("subteams").delete().eq("id", st!.id);
      await svc.from("subteams").delete().like("name", `SyncTest-${stamp}%`);
    }
  });
});
