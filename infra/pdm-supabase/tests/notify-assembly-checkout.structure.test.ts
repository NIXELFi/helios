import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The master-assembly check-out bot is deliberately standalone: a problem in it
// must not be able to reach the PM and Vault Slack bots. This pins that at the
// source level. Behaviour is covered by notify-assembly-checkout.harness.mjs.
const DIR = fileURLToPath(new URL("../supabase/migrations/", import.meta.url));
const file = readdirSync(DIR).find((f) => f.startsWith("20261031000000"))!;
const sql = readFileSync(DIR + file, "utf8");

describe("assembly bot stays separate from the existing Slack bots", () => {
  it("does not redefine their sender", () => {
    expect(sql).not.toMatch(/function\s+notify\.dispatch\s*\(/i);
  });

  it("does not touch their queue or delivery log", () => {
    expect(sql).not.toMatch(/notify\.(outbox|deliveries)\b/i);
  });

  it("does not read their webhooks", () => {
    expect(sql).not.toContain("slack_wf_");
    expect(sql).not.toContain("slack_fallback_email");
  });

  it("schedules only its own cron job", () => {
    const jobs = [...sql.matchAll(/cron\.(?:schedule|unschedule)\s*\(\s*'([^']+)'/gi)].map((m) => m[1]);
    expect(jobs).toEqual(["helios-assembly-alert-dispatch"]);
  });
});

describe("assembly alert webhooks stay out of reach", () => {
  it("never commits a real webhook", () => {
    expect(sql).not.toMatch(/hooks\.slack\.com\/(services|triggers|workflows)/);
  });

  it("does not return the URL from the settings read", () => {
    const get = /function pdm\.assembly_alert_get[\s\S]*?\$function\$([\s\S]*?)\$function\$/.exec(sql)![1]!;
    expect(get).not.toContain("decrypted_secret");
  });

  it("locks the RPCs down to signed-in callers", () => {
    expect(sql).toMatch(/revoke all on function pdm\.assembly_alert_get\(uuid\) from public, anon/);
    expect(sql).toMatch(/revoke all on function pdm\.assembly_alert_set\(uuid, boolean, uuid, text\) from public, anon/);
  });
});
