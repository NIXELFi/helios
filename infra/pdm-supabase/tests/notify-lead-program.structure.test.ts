import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 2026-10-07: an EV Chassis task pinged the IC Chassis lead, because the
// enqueue triggers resolved the lead from the subteam alone. 20261007000000
// made notify.lead_email car-aware (subteam + the task's project) and dropped
// the subteam-only overload. plpgsql bodies aren't dependency-tracked, so a
// later migration that re-copies an older trigger body would silently call the
// dropped 1-arg resolver -- and the trigger's `exception when others` would
// swallow the error and drop every notification. This pins the LATEST
// definition of each trigger function to the 2-arg call.
const DIR = fileURLToPath(new URL("../supabase/migrations/", import.meta.url));
const FIX = "20261007000000";

const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => ({ file: f, sql: readFileSync(DIR + f, "utf8") }));

/** Body of the last `create [or replace] function <name>()` across all migrations. */
function latestBody(name: string): { file: string; body: string } | null {
  const re = new RegExp(
    `create\\s+(?:or\\s+replace\\s+)?function\\s+${name.replace(".", "\\.")}\\s*\\(\\)[\\s\\S]*?\\$function\\$([\\s\\S]*?)\\$function\\$`,
    "gi",
  );
  let found: { file: string; body: string } | null = null;
  for (const { file, sql } of files) {
    for (const m of sql.matchAll(re)) found = { file, body: m[1]! };
  }
  return found;
}

describe("PM notify triggers resolve the lead per car program", () => {
  it("has the migration that introduced car-aware lead resolution", () => {
    expect(files.some((f) => f.file.startsWith(FIX))).toBe(true);
  });

  it.each(["notify.enqueue_from_task", "notify.enqueue_from_comment"])(
    "latest %s passes the task's project to notify.lead_email",
    (name) => {
      const latest = latestBody(name);
      expect(latest, `${name} not found`).not.toBeNull();
      expect(latest!.file.slice(0, 14) >= FIX, `latest ${name} is in ${latest!.file}`).toBe(true);
      const calls = [...latest!.body.matchAll(/notify\.lead_email\s*\(([^)]*)\)/gi)].map((m) => m[1]!.trim());
      expect(calls).toEqual(["v_subteam_id, v_pid"]);
    },
  );

  it("no migration after the fix re-creates the subteam-only lead_email", () => {
    for (const { file, sql } of files.filter((f) => f.file.slice(0, 14) > FIX)) {
      expect(/function\s+notify\.lead_email\s*\(\s*p_subteam\s+uuid\s*\)/i.test(sql), file).toBe(false);
    }
  });

  it("the fix migration drops the 1-arg resolver and locks down the setter", () => {
    const sql = files.find((f) => f.file.startsWith(FIX))!.sql;
    expect(sql).toMatch(/drop\s+function\s+if\s+exists\s+notify\.lead_email\(uuid\)/i);
    expect(sql).toMatch(/revoke\s+all\s+on\s+function\s+pm\.set_role_program\([^)]*\)\s+from\s+public,\s*anon/i);
    expect(sql).toMatch(/grant\s+execute\s+on\s+function\s+pm\.set_role_program\([^)]*\)\s+to\s+authenticated/i);
  });
});
