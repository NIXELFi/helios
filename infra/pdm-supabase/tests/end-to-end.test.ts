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

    // Verify audit trail covers all five operations.
    const { data: audit } = await svc
      .from("audit_log").select("action").order("ts", { ascending: true });
    const actions = audit!.map((r) => r.action);
    expect(actions).toEqual(["check_out", "check_in", "check_out", "force_unlock"]);
  });
});
