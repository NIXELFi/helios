/**
 * Demo data for trying the Purchasing module against a LOCAL Supabase stack.
 * Made-up people and parts; the budget lines mirror the 2026-27 budget sheet.
 *
 *   pnpm exec tsx scripts/seed-purchasing-demo.ts
 *
 * The demo accounts are @demo.test, so the local database must be marked as
 * a test environment first (after every `supabase db reset`), as for the tests:
 *   psql -U supabase_admin -c "ALTER DATABASE postgres SET app.environment='test';"
 *
 * Refuses to run against anything but localhost. Demo accounts share one
 * password, read from DEMO_PASSWORD in .env (generated and saved there on
 * first run). Safe to re-run: it clears purchasing data and re-seeds.
 */
import { config } from "dotenv";
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

config();
const url = process.env.SUPABASE_URL ?? "";
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(url)) {
  throw new Error(`Refusing to seed demo data into non-local ${url}`);
}
let password = process.env.DEMO_PASSWORD;
if (!password) {
  password = `demo-${randomBytes(9).toString("base64url")}`;
  appendFileSync(join(import.meta.dirname, "..", ".env"), `\nDEMO_PASSWORD=${password}\n`);
}
const svc = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const pm = svc.schema("pm");
const pur = svc.schema("purchasing");

function must<T>(r: { data: T; error: unknown }): T {
  if (r.error) throw r.error;
  return r.data;
}

// The subteams in the Airtable cost tracker and Budget.xlsx (the source of
// truth for purchasing), plus Performance Analysis. [name, code, color]
const SUBTEAMS: [string, string, string][] = [
  ["Aero", "AER", "#3ecf8e"], ["Brakes", "BRK", "#f25f5c"], ["Chassis", "CHA", "#a78bfa"], ["Data AQ", "DAQ", "#4ea8ff"],
  ["Driver Interface", "DRI", "#f472b6"], ["Drivetrain", "DRV", "#fb923c"], ["Engine", "ENG", "#facc15"],
  ["Suspension", "SUS", "#60a5fa"], ["Low Voltage", "LV", "#34d399"], ["High Voltage", "HV", "#f97316"],
  ["Battery", "BAT", "#eab308"], ["Machining", "MCH", "#94a3b8"], ["Manufacturing", "MFG", "#9ca3af"],
  ["Marketing", "MKT", "#e879f9"], ["Operations", "OPS", "#c084fc"], ["Overall Team", "TEAM", "#d4d4d8"],
  ["Performance Analysis", "PAL", "#fde047"],
];

// From Budget.xlsx "Actual Budget", 2026-27. [car, line, cents, subteam codes]
const BUDGETS: [string, string, number, string[]][] = [
  ["SDM27", "Engine", 850000, ["ENG"]], ["SDM27", "Data AQ", 420000, ["DAQ"]],
  ["SDM27", "Chassis", 450000, ["CHA"]], ["SDM27", "Driver Interface", 300000, ["DRI"]],
  ["SDM27", "Aero", 268000, ["AER"]], ["SDM27", "Suspension", 80000, ["SUS"]],
  ["SDM27", "Drivetrain", 60000, ["DRV"]], ["SDM27", "Brakes", 50000, ["BRK"]],
  ["SDM27e", "Battery", 600000, ["BAT"]], ["SDM27e", "Chassis", 400000, ["CHA"]],
  ["SDM27e", "Driver Interface", 300000, ["DRI"]], ["SDM27e", "High Voltage", 170000, ["HV"]],
  ["SDM27e", "Low Voltage", 100000, ["LV"]], ["SDM27e", "Suspension", 100000, ["SUS"]],
  ["SDM27e", "Brakes", 80000, ["BRK"]], ["SDM27e", "Drivetrain", 80000, ["DRV"]],
];

async function user(email: string, name: string, roleKey: string, subteamId: string | null) {
  const { data: list } = await svc.auth.admin.listUsers();
  let u = list.users.find((x) => x.email === email);
  if (!u) {
    u = must(await svc.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { display_name: name } })).user!;
  } else {
    await svc.auth.admin.updateUserById(u.id, { password, user_metadata: { display_name: name } });
  }
  const role = must(await pm.from("roles").select("id").eq("key", roleKey).single()) as { id: string };
  await pm.from("role_memberships").delete().eq("user_id", u.id);
  must(await pm.from("role_memberships").insert({ user_id: u.id, role_id: role.id, subteam_id: subteamId }));
  return u;
}

async function main() {
  const st: Record<string, string> = {};
  for (const [i, [name, code, color]] of SUBTEAMS.entries()) {
    const row = must(await pm.from("subteams").upsert({ name, code, slug: code.toLowerCase(), color, sort_order: i }, { onConflict: "code" }).select("id").single()) as { id: string };
    st[code] = row.id;
  }
  const cars: Record<string, string> = {};
  for (const [code, name] of [["SDM27", "SDM27 (IC)"], ["SDM27e", "SDM27e (EV)"]]) {
    const row = must(await pm.from("projects").upsert({ name, car_year: 2027, car_code: code }, { onConflict: "car_code" }).select("id").single()) as { id: string };
    cars[code!] = row.id;
  }

  await pur.from("items").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await pur.from("budget_lines").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await pur.from("seasons").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  const season = must(await pur.from("seasons").insert({ name: "2026-27", is_current: true }).select("id").single()) as { id: string };
  for (const [car, name, cents, codes] of BUDGETS) {
    const line = must(await pur.from("budget_lines").insert({ season_id: season.id, project_id: cars[car], name, amount_cents: cents }).select("id").single()) as { id: string };
    must(await pur.from("budget_line_subteams").insert(codes.map((c) => ({ budget_line_id: line.id, subteam_id: st[c] }))));
  }

  const cfo = await user("cfo@demo.test", "Demo CFO", "executive", null);
  const president = await user("president@demo.test", "Demo President", "executive", null);
  await user("chief@demo.test", "Demo Chief Engineer", "executive", null);
  const daq = await user("daq@demo.test", "Demo DAQ Engineer", "engineer", st.DAQ!);
  await pur.from("settings").update({ value: president.id }).eq("key", "delivery_person_id");

  // Parts, entered as the people who'd really enter them.
  const as = async (email: string) => {
    const c = createClient(url, process.env.SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
    must(await c.auth.signInWithPassword({ email, password: password! }));
    return c.schema("purchasing");
  };
  const eng = await as("daq@demo.test");
  const planned = must(await eng.rpc("add_items", { p_project: cars.SDM27, p_subteam: st.DAQ, p_ready: false, p_rows: [
    { title: "FDCAN transceivers", quantity: 4, unit_price_cents: 312, vendor: "Mouser" },
    { title: "ESP32-S3-WROOM-1U-N8R8", quantity: 10, unit_price_cents: 547, vendor: "Digikey", notes: "Order with cut tape packaging" },
  ] })) as string[];
  const ready = must(await eng.rpc("add_items", { p_project: cars.SDM27, p_subteam: st.DAQ, p_ready: true, p_rows: [
    { title: "8-channel ADC (TI ADC128S102)", quantity: 10, unit_price_cents: 720, vendor: "Mouser", priority: "HIGH", part_number: "ADC128S102CIMTX/NOPB" },
    { title: "IMU IC ST ISM330DHCXTR", quantity: 4, unit_price_cents: 867, tax_shipping_cents: 999, vendor: "Newark", priority: "HIGH", justification: "Repair on SDM26 and the SDM27 logger board" },
  ] })) as string[];
  const exec1 = await as("cfo@demo.test");
  const exec2 = await as("chief@demo.test");
  const approved = must(await exec1.rpc("add_items", { p_project: cars.SDM27, p_subteam: st.AER, p_ready: true, p_rows: [
    { title: "West System 105-B epoxy resin", quantity: 2, unit_price_cents: 11200, tax_shipping_cents: 1814, vendor: "Amazon" },
  ] })) as string[];
  must(await exec2.rpc("decide", { p_id: approved[0], p_decision: "approve" }));
  must(await (await as("president@demo.test")).rpc("decide", { p_id: approved[0], p_decision: "approve" }));
  const ordered = must(await exec1.rpc("add_items", { p_project: cars.SDM27, p_subteam: st.DAQ, p_ready: false, p_rows: [
    { title: "TBM Brakes WSPD cable 3 ft", quantity: 1, unit_price_cents: 3100, tax_shipping_cents: 1620, vendor: "TBM Brakes" },
  ] })) as string[];
  must(await exec1.rpc("set_status", { p_ids: ordered, p_status: "APPROVED" }));
  must(await exec1.rpc("record_order", { p_ids: ordered, p_order_id: "T20001", p_payment: "Team card", p_total_cents: 4720 }));
  must(await exec1.rpc("add_tracking", { p_ids: ordered, p_number: "1Z999AA10123456784", p_carrier: "UPS" }));
  must(await exec1.rpc("add_items", { p_project: cars.SDM27e, p_subteam: st.BAT, p_ready: false, p_rows: [
    { title: "Molicel P50B 21700 cells", quantity: 400, unit_price_cents: 650, vendor: "IMR Batteries" },
  ] }));

  console.log(`Seeded: ${planned.length + ready.length + approved.length + ordered.length + 1} items, ${BUDGETS.length} budget lines.`);
  console.log(`Demo accounts: cfo@demo.test, president@demo.test, chief@demo.test, daq@demo.test (password in .env as DEMO_PASSWORD).`);
  void cfo; void daq;
}

main().catch((e) => { console.error(e); process.exit(1); });
