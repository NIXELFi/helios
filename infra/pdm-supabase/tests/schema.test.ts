import { describe, expect, it } from "vitest";
import { serviceClient } from "./setup.js";

describe("pdm schema", () => {
  it("has all expected tables", async () => {
    const svc = serviceClient();
    const { data, error } = await svc
      .from("information_schema.tables")
      .select("table_name")
      .eq("table_schema", "pdm");
    expect(error).toBeNull();
    const names = (data ?? []).map((r: any) => r.table_name).sort();
    expect(names).toEqual([
      "audit_log",
      "files",
      "folders",
      "locks",
      "refs",
      "user_roles",
      "vaults",
      "versions",
    ]);
  });

  it("locks table has unique-active-lock-per-file index", async () => {
    const svc = serviceClient();
    const { data, error } = await svc
      .from("pg_indexes")
      .select("indexname")
      .eq("schemaname", "pdm")
      .eq("tablename", "locks");
    expect(error).toBeNull();
    const names = (data ?? []).map((r: any) => r.indexname);
    expect(names).toContain("one_active_lock_per_file");
  });
});
