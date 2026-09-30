import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Postgres gives EXECUTE on every new function to PUBLIC, and a per-schema
// `alter default privileges ... revoke` cannot take that away. That default is
// how marketplace.sign_message ended up callable by every signed-in user until
// 20260826010000 stripped it. So every LATER migration that creates a
// marketplace function has to revoke PUBLIC on it itself; this makes forgetting
// that a test failure instead of a security bug.
const DIR = fileURLToPath(new URL("../supabase/migrations/", import.meta.url));
const BASELINE = "20260826010000";

const later = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql") && f.slice(0, 14) > BASELINE)
  .map((f) => ({ file: f, sql: readFileSync(DIR + f, "utf8") }));

describe("marketplace function grants in later migrations", () => {
  it("has the baseline migration this guard starts after", () => {
    expect(readdirSync(DIR).some((f) => f.startsWith(BASELINE))).toBe(true);
  });

  const cases = later.flatMap(({ file, sql }) =>
    [...sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+marketplace\.(\w+)/gi)].map((m) => ({
      file,
      fn: m[1]!,
      sql,
    })),
  );

  it.each(cases.length ? cases : [{ file: "(none yet)", fn: "", sql: "" }])(
    "$file revokes PUBLIC on marketplace.$fn",
    ({ fn, sql }) => {
      if (!fn) return;
      const revoked =
        new RegExp(`revoke\\s+(?:execute|all)\\s+on\\s+function\\s+marketplace\\.${fn}\\b[^;]*from\\s+[^;]*\\bpublic\\b`, "i").test(sql) ||
        /revoke\s+execute\s+on\s+all\s+functions\s+in\s+schema\s+marketplace\s+from\s+[^;]*\bpublic\b/i.test(sql);
      expect(revoked, `add: revoke execute on function marketplace.${fn}(...) from public, anon;`).toBe(true);
    },
  );
});
