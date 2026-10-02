/**
 * Load the standalone SDM ledger (sdm-purchasing-tool) into a LOCAL Supabase
 * stack, through the same finance.restore_ledger() the app's Finance > Bring
 * in data uses, so the two can't drift apart.
 *
 *   # in sdm-purchasing-tool:  python -m sdm.export_helios <path outside the repo>/helios-export.json
 *   pnpm exec tsx scripts/seed-purchasing-demo.ts          # the demo execs (once)
 *   pnpm exec tsx scripts/import-sdm-ledger.ts <that file> <season start, yyyy-mm-dd>
 *
 * Replaces all purchasing and finance data (demo users and their roles are
 * kept, so you can still sign in), then restores as the demo CFO. Subteams the
 * export names that Helios doesn't have yet are created.
 *
 * The export holds real financial data: never commit it. This script refuses
 * to run against anything but localhost; on the team's hosted project the CFO
 * restores from the app.
 */
import { config } from "dotenv";
import WebSocket from "ws";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

// Node < 22 has no native WebSocket, which supabase-js needs at createClient() (as in tests/setup.ts).
(globalThis as any).WebSocket ??= WebSocket;
config();
const url = process.env.SUPABASE_URL ?? "";
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(url)) throw new Error(`Refusing to import into non-local ${url}`);
const [file, seasonStart] = process.argv.slice(2);
if (!file || !/^\d{4}-\d{2}-\d{2}$/.test(seasonStart ?? "")) {
  throw new Error("Usage: tsx scripts/import-sdm-ledger.ts <helios-export.json> <season start, yyyy-mm-dd>");
}
if (!process.env.DEMO_PASSWORD) throw new Error("No DEMO_PASSWORD in .env: run scripts/seed-purchasing-demo.ts first.");

const svc = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const pm = svc.schema("pm");
const pur = svc.schema("purchasing");
const fin = svc.schema("finance");

type Row = Record<string, any>;
const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, Row[]> & { source: string };
if (data.source !== "sdm-ledger") throw new Error("That isn't an export from the SDM ledger.");

function must<T>(r: { data: T; error: { message: string } | null }, what: string): T {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
}
async function wipe(table: ReturnType<typeof svc.schema>, name: string, col = "id") {
  must(await table.from(name).delete().not(col, "is", null), `clear ${name}`);
}

// Subteam codes for names that aren't in Helios yet (matched by name first).
const CODES: Record<string, [string, string]> = {
  Aero: ["AER", "#3ecf8e"], Brakes: ["BRK", "#f25f5c"], Chassis: ["CHA", "#a78bfa"], "Data AQ": ["DAQ", "#4ea8ff"],
  "Driver Interface": ["DRI", "#f472b6"], Drivetrain: ["DRV", "#fb923c"], Engine: ["ENG", "#facc15"], Suspension: ["SUS", "#60a5fa"],
  "Low Voltage": ["LV", "#34d399"], "High Voltage": ["HV", "#f97316"], Battery: ["BAT", "#eab308"], Machining: ["MCH", "#94a3b8"],
  Manufacturing: ["MFG", "#9ca3af"], Marketing: ["MKT", "#e879f9"], Operations: ["OPS", "#c084fc"], "Overall Team": ["TEAM", "#d4d4d8"],
};

async function main() {
  // ---- cars and subteams
  const cars: Record<string, string> = {};
  for (const [prog, code, name] of [["IC", "SDM27", "SDM27 (IC)"], ["EV", "SDM27e", "SDM27e (EV)"]] as const) {
    cars[prog] = (must(await pm.from("projects").upsert({ name, car_year: 2027, car_code: code }, { onConflict: "car_code" }).select("id").single(), "project") as Row).id;
  }
  const existing = must(await pm.from("subteams").select("id,name"), "subteams") as Row[];
  const st: Record<string, string> = {};
  const byName = new Map(existing.map((s) => [String(s.name).toLowerCase(), s.id as string]));
  const names = new Set<string>(["allocations", "line_item_allocations", "budgets", "evidence"]
    .flatMap((k) => (data[k] ?? []).map((r) => r.subteam).filter(Boolean)));
  let order = existing.length;
  for (const name of names) {
    let id = byName.get(name.toLowerCase());
    if (!id) {
      const [code, color] = CODES[name] ?? [name.replace(/[^A-Za-z]/g, "").slice(0, 4).toUpperCase(), "#8d8d97"];
      id = (must(await pm.from("subteams").insert({ name, code, slug: code.toLowerCase(), color, sort_order: order++ }).select("id").single(), `subteam ${name}`) as Row).id;
    }
    st[name] = id!;
  }

  // ---- clear purchasing and finance (the restore only fills an empty Agora)
  await wipe(pur, "items");
  await wipe(pur, "budget_lines");
  await wipe(pur, "seasons");
  await wipe(pur, "notifications");
  await wipe(fin, "imports");
  for (const t of ["reimbursement_receipts", "reimbursements", "evidence", "balance_entries", "txn_allocations", "transactions", "statements"]) await wipe(fin, t);
  must(await fin.from("accounts").update({ paid_from_account_id: null }).not("id", "is", null), "unlink accounts");
  await wipe(fin, "accounts");
  await wipe(fin, "discrepancy_resolutions", "key");
  const { data: folders } = await svc.storage.from("receipts").list("", { limit: 1000 });
  for (const f of folders ?? []) {
    const { data: files } = await svc.storage.from("receipts").list(f.name, { limit: 1000 });
    if (files?.length) await svc.storage.from("receipts").remove(files.map((x) => `${f.name}/${x.name}`));
  }

  // ---- restore, as an exec would from the app
  const cfo = createClient(url, process.env.SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
  const { error: signInError } = await cfo.auth.signInWithPassword({ email: "cfo@demo.test", password: process.env.DEMO_PASSWORD! });
  if (signInError) throw new Error(`sign in as cfo@demo.test: ${signInError.message}`);
  const needsTeam = ["budgets", "line_item_allocations"].some((k) => (data[k] ?? []).some((r) => r.program === "Team"));
  const result = must(await cfo.schema("finance").rpc("restore_ledger", {
    p_data: data, p_cars: needsTeam ? { ...cars, Team: cars.IC } : cars, p_subteams: st, p_season_start: seasonStart,
  }), "restore") as Row;
  console.log(`Restored: ${result.accounts} accounts, ${result.statements} statements, ${result.transactions} transactions, `
    + `${result.invoices} invoices/emails, ${result.balances} balances, ${result.reimbursements} reimbursements, `
    + `${result.budget_lines} budget lines, ${result.parts} parts.`);
  if (result.skipped?.length) console.log(`Kept as they were: ${result.skipped.join("; ")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
