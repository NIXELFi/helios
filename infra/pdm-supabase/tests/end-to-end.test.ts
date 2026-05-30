import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTestUser,
  resetAuthUsers,
  serviceClient,
  setRole,
  signInAs,
  uniqueEmail,
} from "./setup.js";

describe("end-to-end: a designer's working day", () => {
  beforeEach(async () => { await resetAuthUsers(); });
  afterEach(async () => { await resetAuthUsers(); });

  it("create vault → check out → check in → check out again → admin force-unlocks", async () => {
    // Setup users.
    const admin = await createTestUser(uniqueEmail("admin"));
    await setRole(admin.id, "admin");
    const designer = await createTestUser(uniqueEmail("designer"));
    await setRole(designer.id, "editor");

    // Admin: create vault, folder, file.
    const aClient = await signInAs(admin.email!);
    const { data: vault } = await aClient
      .from("vaults").insert({ name: "sdm26", created_by: admin.id }).select().single();
    const { data: folder } = await aClient
      .from("folders").insert({ vault_id: vault!.id, name: "chassis" }).select().single();
    const { data: file } = await aClient
      .from("files").insert({ vault_id: vault!.id, folder_id: folder!.id, name: "frame.sldprt" }).select().single();

    // Designer: check out, check in v1.
    const dClient = await signInAs(designer.email!);
    await dClient.from("locks").insert({ file_id: file!.id, user_id: designer.id });
    const { data: v1 } = await dClient.rpc("pdm_check_in", {
      p_file_id: file!.id, p_sha256: "1".repeat(64), p_size: 100, p_comment: "first cut",
    });
    expect(v1.version_num).toBe(1);

    // Designer: check out again. Goes to vacation mid-edit.
    const { data: lock2 } = await dClient
      .from("locks").insert({ file_id: file!.id, user_id: designer.id }).select().single();

    // Admin: force-unlocks because designer is unreachable.
    await aClient.rpc("pdm_force_unlock", { p_lock_id: lock2!.id, p_reason: "designer on vacation, blocking team" });

    // Verify: file's latest_version_id still points at v1; lock2 marked released by admin.
    const svc = serviceClient();
    const { data: fileNow } = await svc.from("files").select("latest_version_id").eq("id", file!.id).single();
    expect(fileNow!.latest_version_id).toBe(v1.id);

    const { data: locks } = await svc.from("locks").select("id, released_at, force_released_by").eq("file_id", file!.id);
    const lock2Now = locks!.find((l) => l.id === lock2!.id)!;
    expect(lock2Now.released_at).not.toBeNull();
    expect(lock2Now.force_released_by).toBe(admin.id);

    // Verify audit trail covers every state transition. Migration
    // 20260511000200_pdm_locks_update_audit.sql added a `lock_released`
    // row to the audit feed each time pdm.check_in / pdm.cancel_checkout /
    // pdm.force_unlock flips released_at — so a designer's check_out followed
    // by a check_in produces two rows (check_out, lock_released, check_in).
    const { data: audit } = await svc
      .from("audit_log").select("action").order("ts", { ascending: true });
    // Scope to the lock/version LIFECYCLE actions this test exercises. The feed
    // also carries structural + role events (file_create, folder_create,
    // role_grant, … — see 20260530130000_pdm_audit_structural_events.sql) from
    // the seed/setRole calls; those aren't what this scenario asserts.
    const lifecycle = new Set(["check_out", "lock_released", "check_in", "cancel_checkout", "force_unlock"]);
    const actions = audit!.map((r) => r.action).filter((a) => lifecycle.has(a));
    expect(actions).toEqual([
      "check_out",      // lock acquired for v1 edit
      "lock_released",  // pdm.check_in releases the v1 lock
      "check_in",       // v1 written
      "check_out",      // second lock for the vacation-blocked edit
      "lock_released",  // pdm.force_unlock releases the vacation lock
      "force_unlock",   // explicit force-unlock audit row
    ]);
  });
});
