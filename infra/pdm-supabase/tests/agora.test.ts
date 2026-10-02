import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestUser, resetAuthUsers, serviceClient, signInAs, uniqueEmail } from "./setup.js";

/**
 * 20261002000000 Agora follow-ups: cash reimbursements, seasons and budget
 * lines from the app, order costs split per part, Airtable rows imported with
 * their history, and the one-time restore of the standalone ledger. All
 * figures and names are made up.
 */

const pm = () => serviceClient().schema("pm");
const fin = () => serviceClient().schema("finance");
const pur = () => serviceClient().schema("purchasing");
const NIL = "00000000-0000-0000-0000-000000000000";

async function subteam(name: string, code: string): Promise<string> {
  const { data, error } = await pm().from("subteams").upsert({ name, code, slug: code.toLowerCase() }, { onConflict: "code" }).select("id").single();
  if (error) throw error;
  return data!.id;
}
async function project(code: string): Promise<string> {
  const { data, error } = await pm().from("projects").upsert({ name: code, car_year: 2027, car_code: code }, { onConflict: "car_code" }).select("id").single();
  if (error) throw error;
  return data!.id;
}
async function person(prefix: string, roleKey: string, subteamId: string | null = null) {
  const email = uniqueEmail(prefix);
  const user = await createTestUser(email);
  const { data: role } = await pm().from("roles").select("id").eq("key", roleKey).single();
  const { error } = await pm().from("role_memberships").insert({ user_id: user.id, role_id: role!.id, subteam_id: subteamId });
  if (error) throw error;
  const client = await signInAs(email);
  return { user, f: client.schema("finance"), p: client.schema("purchasing"), pm: client.schema("pm") };
}
async function reset(): Promise<void> {
  const all = (t: string) => fin().from(t).delete().gte("id", 0);
  await pur().from("items").delete().neq("id", NIL);
  await pur().from("budget_lines").delete().neq("id", NIL);
  await pur().from("seasons").delete().neq("id", NIL);
  await pur().from("notifications").delete().gte("id", 0);
  await all("imports");
  await all("reimbursement_receipts");
  await all("reimbursements");
  await all("evidence");
  await all("balance_entries");
  await all("transactions");
  await all("statements");
  await fin().from("accounts").update({ paid_from_account_id: null }).gte("id", 0);
  await all("accounts");
  await fin().from("discrepancy_resolutions").delete().neq("key", "");
}

describe("agora follow-ups", () => {
  let daq: string, ic: string, ev: string;

  beforeEach(async () => {
    await resetAuthUsers();
    await reset();
    daq = await subteam("Data AQ", "DAQ");
    ic = await project("SDM27");
    ev = await project("SDM27e");
  });
  afterEach(async () => {
    // the org structure's map for the test cars (Admin > Org Structure)
    await pm().from("project_subteams").delete().in("project_id", [ic, ev]);
    await reset();
    await resetAuthUsers();
  });

  it("pays reimbursements in cash from the cash box or the bank, and keeps how they were paid", async () => {
    await fin().from("accounts").insert({ name: "Chase Checking", kind: "checking", last4: "0001" });
    const cfo = await person("cfo", "executive");
    const member = await person("member", "engineer", daq);
    const ask = async (cents: number) => {
      const { data: id, error } = await member.f.rpc("request_reimbursement", { p_amount_cents: cents, p_reason: "Zip ties" });
      expect(error).toBeNull();
      expect((await cfo.f.rpc("decide_reimbursement", { p_id: id, p_decision: "approve" })).error).toBeNull();
      return id as number;
    };
    const a = await ask(1250), b = await ask(800);

    const { error: memberErr } = await member.f.rpc("record_reimbursement_payment",
      { p_ids: [a], p_method: "cash_box", p_paid_date: "2026-09-20", p_check_number: "", p_add_to_ledger: true });
    expect(memberErr).not.toBeNull();

    const { data: boxTxn, error } = await cfo.f.rpc("record_reimbursement_payment",
      { p_ids: [a], p_method: "cash_box", p_paid_date: "2026-09-20", p_check_number: "", p_add_to_ledger: true });
    expect(error).toBeNull();
    const { data: box } = await fin().from("transactions").select("amount_cents,kind,category,accounts(name,kind)").eq("id", boxTxn).single();
    expect(box).toMatchObject({ amount_cents: -1250, kind: "withdrawal", category: "Reimbursement", accounts: { name: "Cash Box", kind: "holding" } });

    const { data: bankTxn } = await cfo.f.rpc("record_reimbursement_payment",
      { p_ids: [b], p_method: "bank_cash", p_paid_date: "2026-09-21", p_check_number: "", p_add_to_ledger: true });
    const { data: bank } = await fin().from("transactions").select("amount_cents,accounts(kind)").eq("id", bankTxn).single();
    expect(bank).toMatchObject({ amount_cents: -800, accounts: { kind: "checking" } });

    const { data: rows } = await member.f.from("reimbursements").select("id,status,paid_with").order("id");
    expect(rows).toEqual([{ id: a, status: "paid", paid_with: "cash_box" }, { id: b, status: "paid", paid_with: "bank_cash" }]);
    // how it was paid can't be edited afterwards
    await cfo.f.from("reimbursements").update({ paid_with: "check" }).eq("id", a);
    expect((await fin().from("reimbursements").select("paid_with").eq("id", a).single()).data!.paid_with).toBe("cash_box");
    // and paying twice is refused
    expect((await cfo.f.rpc("record_reimbursement_payment",
      { p_ids: [a], p_method: "cash_box", p_paid_date: null, p_check_number: "", p_add_to_ledger: false })).error).not.toBeNull();
  });

  it("execs set up seasons and budget lines; members can't", async () => {
    const cfo = await person("cfo", "executive");
    const member = await person("member", "engineer", daq);
    expect((await member.p.rpc("upsert_season", { p_id: null, p_name: "2026-27", p_starts_on: null, p_ends_on: null, p_current: true })).error).not.toBeNull();

    const { data: s1 } = await cfo.p.rpc("upsert_season", { p_id: null, p_name: "2026-27", p_starts_on: "2026-07-01", p_ends_on: "2027-06-30", p_current: true });
    const { data: s2 } = await cfo.p.rpc("upsert_season", { p_id: null, p_name: "2027-28", p_starts_on: null, p_ends_on: null, p_current: true });
    const { data: seasons } = await pur().from("seasons").select("id,is_current").order("name");
    expect(seasons).toEqual([{ id: s1, is_current: false }, { id: s2, is_current: true }]);
    expect((await cfo.p.rpc("upsert_season", { p_id: s1, p_name: "2026-27", p_starts_on: "2026-07-01", p_ends_on: "2026-01-01", p_current: false })).error).not.toBeNull();

    const { data: line, error } = await cfo.p.rpc("upsert_budget_line",
      { p_id: null, p_season: s2, p_project: ic, p_name: "Data AQ", p_amount_cents: 420000, p_subteams: [daq] });
    expect(error).toBeNull();
    expect((await member.p.rpc("delete_budget_line", { p_id: line })).error).not.toBeNull();
    expect((await cfo.p.rpc("delete_budget_line", { p_id: line })).error).toBeNull();
    expect((await pur().from("budget_lines").select("id")).data).toHaveLength(0);
  });

  it("records each part's share of an order, and only for approved parts", async () => {
    const cfo = await person("cfo", "executive");
    const chief = await person("chief", "executive");
    const member = await person("member", "engineer", daq);
    const { data: ids } = await member.p.rpc("add_items", { p_project: ic, p_subteam: daq, p_ready: true, p_rows: [
      { title: "ADC", quantity: 2, unit_price_cents: 3000 }, { title: "TVS diodes", quantity: 10, unit_price_cents: 100 },
    ] });
    const [adc, tvs] = ids as string[];
    const lines = [{ id: adc, actual_total_cents: 6372, tax_shipping_cents: 372 }, { id: tvs, actual_total_cents: 1062, tax_shipping_cents: 62 }];
    const args = { p_lines: lines, p_order_id: "W100", p_payment: "SAE card", p_ordered_on: "2026-09-10", p_total_cents: 7434, p_paid_by: "" };
    expect((await cfo.p.rpc("record_order_lines", args)).error?.message).toMatch(/approved/);

    for (const id of [adc, tvs]) for (const exec of [cfo, chief]) await exec.p.rpc("decide", { p_id: id, p_decision: "approve" });
    expect((await member.p.rpc("record_order_lines", args)).error).not.toBeNull();
    expect((await cfo.p.rpc("record_order_lines", { ...args, p_total_cents: 7500 })).error?.message).toMatch(/add up/);
    // the same part twice would count twice in the sum but be stored once
    const twice = [{ id: adc, actual_total_cents: 100 }, { id: adc, actual_total_cents: 6272 }, { id: tvs, actual_total_cents: 1062 }];
    expect((await cfo.p.rpc("record_order_lines", { ...args, p_lines: twice })).error?.message).toMatch(/twice/);
    expect((await cfo.p.rpc("record_order_lines", args)).error).toBeNull();
    const { data: rows } = await pur().from("items").select("title,status,vendor_order_id,actual_total_cents,tax_shipping_cents").order("title");
    expect(rows).toEqual([
      { title: "ADC", status: "ORDERED", vendor_order_id: "W100", actual_total_cents: 6372, tax_shipping_cents: 372 },
      { title: "TVS diodes", status: "ORDERED", vendor_order_id: "W100", actual_total_cents: 1062, tax_shipping_cents: 62 },
    ]);
  });

  it("execs import Airtable rows with their status; members can't", async () => {
    const cfo = await person("cfo", "executive");
    const member = await person("member", "engineer", daq);
    const rows = [
      { title: "UV flashlight", quantity: 1, unit_price_cents: 659, status: "RECEIVED", source: "airtable:IC/Data AQ row 2", date_needed_raw: "2026-09-03" },
      { title: "Logger ADC", quantity: 2, unit_price_cents: 926, status: "ORDERED" },
      { title: "FDCAN transceivers", status: "PLANNED" },
    ];
    expect((await member.p.rpc("import_items", { p_project: ic, p_subteam: daq, p_rows: rows })).error).not.toBeNull();
    expect((await cfo.p.rpc("import_items", { p_project: ic, p_subteam: daq, p_rows: [{ title: "x", status: "APPROVED" }] })).error).not.toBeNull();
    const { data: n, error } = await cfo.p.rpc("import_items", { p_project: ic, p_subteam: daq, p_rows: rows });
    expect(error).toBeNull();
    expect(n).toBe(3);
    const { data } = await pur().from("items").select("title,status,source,date_needed_raw,total_estimate_cents,item_allocations(project_id,subteam_id)").order("title");
    expect(data!.map((r) => [r.title, r.status])).toEqual([["FDCAN transceivers", "PLANNED"], ["Logger ADC", "ORDERED"], ["UV flashlight", "RECEIVED"]]);
    expect(data![2]).toMatchObject({ source: "airtable:IC/Data AQ row 2", date_needed_raw: "2026-09-03", total_estimate_cents: 659,
      item_allocations: [{ project_id: ic, subteam_id: daq }] });

    // a part imported already ordered skipped approvals: whoever imported it
    // can't also put an order and its cost on it, another exec can
    const chief = await person("chief", "executive");
    const { data: logger } = await pur().from("items").select("id").eq("title", "Logger ADC").single();
    const order = { p_ids: [logger!.id], p_order_id: "W9", p_payment: "SAE card", p_total_cents: 600000 };
    expect((await cfo.p.rpc("record_order", order)).error?.message).toMatch(/another exec/);
    expect((await cfo.p.rpc("record_order_lines", { p_lines: [{ id: logger!.id, actual_total_cents: 600000 }], p_order_id: "W9", p_payment: "SAE card" }))
      .error?.message).toMatch(/another exec/);
    // nor through update_item's buyer fields
    expect((await cfo.p.rpc("update_item", { p_id: logger!.id, p_patch: { actual_total_cents: 999999 } })).error?.message).toMatch(/another exec/);
    expect((await chief.p.rpc("record_order", { ...order, p_total_cents: 1900 })).error).toBeNull();
  });

  it("won't mark a reimbursement paid that has no amount", async () => {
    await fin().from("accounts").insert({ name: "Chase Checking", kind: "checking", last4: "0001" });
    const cfo = await person("cfo", "executive");
    const { data: r } = await cfo.f.from("reimbursements").insert({ person_name: "Demo Member", reason: "Gloves" }).select("id").single();
    for (const method of ["check", "cash_box", "bank_cash"]) {
      const { error } = await cfo.f.rpc("record_reimbursement_payment",
        { p_ids: [r!.id], p_method: method, p_paid_date: null, p_check_number: "101", p_add_to_ledger: true });
      expect(error?.message).toMatch(/amount first/);
    }
    expect((await fin().from("reimbursements").select("status").eq("id", r!.id).single()).data!.status).toBe("owed");

    // the cash box has no statement, so its payment has to go in the ledger
    await fin().from("reimbursements").update({ amount_cents: 1200 }).eq("id", r!.id);
    expect((await cfo.f.rpc("record_reimbursement_payment",
      { p_ids: [r!.id], p_method: "cash_box", p_paid_date: null, p_check_number: null, p_add_to_ledger: false })).error?.message).toMatch(/ledger/);
    // and a new row can't arrive already paid
    expect((await cfo.f.from("reimbursements").insert({ person_name: "Demo Member", reason: "x", amount_cents: 5, paid_with: "cash_box" })).error).not.toBeNull();
    expect((await cfo.f.from("reimbursements").insert({ person_name: "Demo Member", reason: "x", amount_cents: 5, check_number: "1001" })).error).not.toBeNull();
  });

  it("an order recorded by mistake can be undone; recording it again keeps what was there", async () => {
    const cfo = await person("cfo", "executive");
    const chief = await person("chief", "executive");
    const member = await person("member", "engineer", daq);
    const { data: ids } = await member.p.rpc("add_items", { p_project: ic, p_subteam: daq, p_ready: true, p_rows: [{ title: "ADC", quantity: 1, unit_price_cents: 900 }] });
    const id = (ids as string[])[0]!;
    for (const exec of [cfo, chief]) await exec.p.rpc("decide", { p_id: id, p_decision: "approve" });
    await cfo.p.rpc("record_order", { p_ids: [id], p_order_id: "W1", p_payment: "Own card", p_total_cents: 950, p_paid_by: "Demo Member" });
    // again, to correct the total: "member who paid" isn't wiped
    await cfo.p.rpc("record_order", { p_ids: [id], p_order_id: "", p_payment: "", p_total_cents: 975, p_paid_by: "" });
    expect((await pur().from("items").select("paid_by,vendor_order_id,actual_total_cents").eq("id", id).single()).data)
      .toEqual({ paid_by: "Demo Member", vendor_order_id: "W1", actual_total_cents: 975 });

    expect((await member.p.rpc("undo_order", { p_ids: [id] })).error).not.toBeNull();
    expect((await cfo.p.rpc("undo_order", { p_ids: [id] })).error).toBeNull();
    expect((await pur().from("items").select("status,vendor_order_id,actual_total_cents,paid_by").eq("id", id).single()).data)
      .toEqual({ status: "APPROVED", vendor_order_id: null, actual_total_cents: null, paid_by: "" });
    // still approved, so it can be ordered again; once received it can't be undone
    expect((await cfo.p.rpc("record_order", { p_ids: [id], p_order_id: "W2", p_payment: "SAE card" })).error).toBeNull();
    await member.p.rpc("set_status", { p_ids: [id], p_status: "RECEIVED" });
    expect((await cfo.p.rpc("undo_order", { p_ids: [id] })).error?.message).toMatch(/not yet received/);
  });

  it("an account can be deleted while nothing is recorded against it, and its type changed", async () => {
    const cfo = await person("cfo", "executive");
    const { data: a } = await cfo.f.from("accounts").insert({ name: "EV Dean's Funding", kind: "holding" }).select("id").single();
    expect((await cfo.f.from("accounts").update({ kind: "university" }).eq("id", a!.id)).error).toBeNull();
    const { data: b } = await cfo.f.from("accounts").insert({ name: "Chase Checking", kind: "checking" }).select("id").single();
    await fin().from("transactions").insert({ account_id: b!.id, date: "2026-09-01", amount_cents: -100, kind: "withdrawal" });
    expect((await cfo.f.rpc("delete_account", { p_id: b!.id })).error?.message).toMatch(/1 ledger lines/);
    expect((await cfo.f.rpc("delete_account", { p_id: a!.id })).error).toBeNull();
    expect((await fin().from("accounts").select("name")).data).toEqual([{ name: "Chase Checking" }]);
  });

  it("each car's subteams come from the org structure; members add parts only to those", async () => {
    const eng = await subteam("Engine", "ENG");
    await pm().from("project_subteams").delete().in("project_id", [ic, ev]);
    const cfo = await person("cfo", "executive");
    const member = await person("member", "engineer", daq);
    // a car the org structure says nothing about takes any subteam
    expect((await member.p.rpc("add_items", { p_project: ev, p_subteam: daq, p_rows: [{ title: "x" }] })).error).toBeNull();
    // IC gets Engine in Admin > Org Structure (the same RPC Agora's tab bar uses); members can't edit it
    expect((await cfo.pm.rpc("set_project_subteam", { p_project_id: ic, p_subteam_id: eng, p_present: true })).error).toBeNull();
    expect((await member.pm.rpc("set_project_subteam", { p_project_id: ic, p_subteam_id: daq, p_present: true })).error).not.toBeNull();
    expect((await member.p.rpc("add_items", { p_project: ic, p_subteam: daq, p_rows: [{ title: "y" }] })).error?.message).toMatch(/isn't on this car/);
    await cfo.pm.rpc("set_project_subteam", { p_project_id: ic, p_subteam_id: daq, p_present: true });
    expect((await member.p.rpc("add_items", { p_project: ic, p_subteam: daq, p_rows: [{ title: "y", date_needed_raw: "9/11/2026" }] })).error).toBeNull();
    expect((await pur().from("items").select("date_needed_raw").eq("title", "y").single()).data!.date_needed_raw).toBe("9/11/2026");
    // EV set up with Engine only: DAQ already has a part there, so its member keeps adding; Aero can't
    await cfo.pm.rpc("set_project_subteam", { p_project_id: ev, p_subteam_id: eng, p_present: true });
    expect((await member.p.rpc("add_items", { p_project: ev, p_subteam: daq, p_rows: [{ title: "w" }] })).error).toBeNull();
    const aero = await subteam("Aero", "AERO");
    const aeroMember = await person("aero", "engineer", aero);
    expect((await aeroMember.p.rpc("add_items", { p_project: ev, p_subteam: aero, p_rows: [{ title: "v" }] })).error?.message).toMatch(/isn't on this car/);
    // the old Agora-only map is gone
    expect((await pur().from("car_subteams").select("*")).error).not.toBeNull();
  });

  it("execs delete parts, except ones matched to a ledger charge, and the history says so", async () => {
    const cfo = await person("cfo", "executive");
    const member = await person("member", "engineer", daq);
    const { data: ids } = await member.p.rpc("add_items", { p_project: ic, p_subteam: daq, p_rows: [{ title: "Test row" }, { title: "Charged part" }] });
    const [test, charged] = ids as string[];
    const { data: acct } = await fin().from("accounts").insert({ name: "Card", kind: "credit_card" }).select("id").single();
    const { data: t } = await fin().from("transactions").insert({ account_id: acct!.id, date: "2026-09-01", amount_cents: -500, kind: "charge" }).select("id").single();
    await pur().from("items").update({ finance_txn_id: t!.id }).eq("id", charged!);

    expect((await member.p.rpc("delete_items", { p_ids: [test] })).error).not.toBeNull();
    expect((await cfo.p.rpc("delete_items", { p_ids: [test, charged] })).error?.message).toMatch(/matched to a ledger charge/);
    const { data: n, error } = await cfo.p.rpc("delete_items", { p_ids: [test] });
    expect(error).toBeNull();
    expect(n).toBe(1);
    expect((await pur().from("items").select("title")).data).toEqual([{ title: "Charged part" }]);
    expect((await pur().from("events").select("field,old_value").eq("item_id", test!).eq("field", "deleted")).data)
      .toEqual([{ field: "deleted", old_value: expect.stringMatching(/Test row$/) }]);
  });

  it("restores the standalone ledger into an empty Agora, once, for execs only", async () => {
    const cfo = await person("cfo", "executive");
    const member = await person("member", "engineer", daq);
    const data = {
      source: "sdm-ledger",
      categories: [{ name: "Parts & materials", direction: "out", description: "" }],
      vendors: [{ name: "Mouser", aliases: "Mouser Electronics|MOUSER", merchant_pattern: "mouser", default_category: "Parts & materials", review_note: "" }],
      accounts: [
        { id: 1, name: "Chase Checking", kind: "checking", last4: "0001", active: 1 },
        { id: 8, name: "SAE card", kind: "credit_card", last4: "0000", holder: "Demo CFO", credit_limit_cents: 500000, paid_from_account_id: 1, active: 1 },
      ],
      statements: [{ id: 3, account_id: 8, period_start: "2026-08-01", closing_date: "2026-08-28", net_charges_cents: 4720, purchases_cents: 4720, credits_cents: 0, source_file: "card.pdf", sha256: "abc", imported_at: "2026-09-01T00:00:00Z" },
        // a checking statement: only its closing and ending balance
        { id: 4, account_id: 1, closing_date: "2026-08-31", ending_cents: 100000 }],
      transactions: [
        { id: 10, account_id: 8, date: "2026-08-20", amount_cents: -4720, description: "MOUSER", vendor: "Mouser", kind: "charge", category: "Parts & materials", status: "posted", needs_review: 0, source: "chase-card-pdf", source_key: "k10", statement_id: 3, notes: "" },
        { id: 11, account_id: 1, date: "2026-09-02", amount_cents: -2000, description: "Check 101", kind: "check", category: "Reimbursement", reference: "101", status: "posted", needs_review: 0, source: "manual", notes: "" },
      ],
      allocations: [{ id: 5, txn_id: 10, program: "IC", subteam: "Data AQ", amount_cents: 4720 }],
      evidence: [{ id: 2, kind: "invoice", source_file: "inv.pdf", source_key: "e2", vendor: "Mouser", date: "2026-08-19", total_cents: 4720, items: "ADC", program: "IC", subteam: "Data AQ", flags_json: "[]", txn_id: 10 }],
      balance_entries: [{ id: 4, account_id: 1, as_of: "2026-09-01", balance_cents: 1000000, entered_by: "Demo CFO", entered_at: "2026-09-01T12:00:00Z", confirmed: 1, measure: "balance" }],
      reimbursements: [
        { id: 7, person: "Demo Member", amount_cents: 2000, reason: "Gloves", requested_date: "2026-08-30", paid: 1, check_number: "101", check_txn_id: 11, paid_date: "2026-09-02" },
        { id: 9, person: "Demo Member", amount_cents: 650, reason: "Tape", requested_date: "2026-09-10", paid: 0 },
      ],
      budgets: [{ season: "2026-27", program: "IC", subteam: "Data AQ", amount_cents: 420000, notes: "" }],
      discrepancy_resolutions: [{ key: "recon:1:2026-09-01", resolved_by: "Demo CFO", resolved_at: "2026-09-02T00:00:00Z", note: "ok" }],
      line_items: [{ id: 1, item_code: "SDM-0042", title: "ADC", status: "RECONCILED", priority: "HIGH", quantity: 2, unit_price_cents: 2360, total_estimate_cents: 4720, vendor: "Mouser", txn_id: 10, payment_account_id: 8, requester_name: "Demo Member" }],
      line_item_allocations: [{ item_id: 1, program: "IC", subteam: "Data AQ", percent: 100 }],
    };
    const args = { p_data: data, p_cars: { IC: ic, EV: ev }, p_subteams: { "Data AQ": daq }, p_season_start: "2026-07-01" };
    expect((await member.f.rpc("restore_ledger", args)).error).not.toBeNull();
    expect((await cfo.f.rpc("restore_ledger", { ...args, p_subteams: {} })).error?.message).toMatch(/Data AQ/);
    expect((await cfo.f.rpc("restore_ledger", { ...args, p_season_start: null })).error?.message).toMatch(/season started/);
    expect((await cfo.f.rpc("restore_ledger", { ...args, p_cars: { IC: ic, EV: ic } })).error?.message).toMatch(/different cars/);
    // whole-team parts need a car to go under
    const team = { ...data, line_item_allocations: [{ item_id: 1, program: "Team", subteam: "Data AQ", percent: 100 }] };
    expect((await cfo.f.rpc("restore_ledger", { ...args, p_data: team })).error?.message).toMatch(/whole-team/);

    // a part split IC + whole team, with the team's parts under IC, is one share
    const split = { ...data, line_item_allocations: [{ item_id: 1, program: "IC", subteam: "Data AQ", percent: 60 }, { item_id: 1, program: "Team", subteam: "Data AQ", percent: 40 }] };
    const { data: r, error } = await cfo.f.rpc("restore_ledger", { ...args, p_data: split, p_cars: { IC: ic, EV: ev, Team: ic } });
    expect(error).toBeNull();
    expect(r).toMatchObject({ transactions: 2, parts: 1, budget_lines: 1, reimbursements: 2 });
    const { data: card } = await fin().from("accounts").select("paid_from_account_id").eq("id", 8).single();
    expect(card!.paid_from_account_id).toBe(1);
    const { data: item } = await pur().from("items").select("code,status,finance_txn_id,payment_method,item_allocations(subteam_id)").single();
    expect(item).toMatchObject({ code: "SDM-0042", status: "RECONCILED", finance_txn_id: 10, payment_method: "SAE card", item_allocations: [{ subteam_id: daq }] });
    expect((await pur().from("item_allocations").select("percent")).data).toEqual([{ percent: 100 }]);
    const { data: reimb } = await fin().from("reimbursements").select("id,status,paid_with").order("id");
    expect(reimb).toEqual([{ id: 7, status: "paid", paid_with: "check" }, { id: 9, status: "owed", paid_with: null }]);
    expect((await pur().from("seasons").select("name,is_current,starts_on")).data).toEqual([{ name: "2026-27", is_current: true, starts_on: "2026-07-01" }]);
    // new rows carry on after the restored ids
    const { data: next } = await fin().from("transactions").insert({ account_id: 1, date: "2026-09-30", amount_cents: -1, kind: "withdrawal" }).select("id").single();
    expect(next!.id).toBe(12);
    const { data: added } = await member.p.rpc("add_items", { p_project: ic, p_subteam: daq, p_rows: [{ title: "Next part" }] });
    expect((await pur().from("items").select("code").eq("id", (added as string[])[0]).single()).data!.code).toBe("SDM-0043");

    // a second restore is refused: it never touches live books
    expect((await cfo.f.rpc("restore_ledger", args)).error?.message).toMatch(/already has/);
  });
});
