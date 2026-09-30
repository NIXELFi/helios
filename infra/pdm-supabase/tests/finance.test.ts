import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTestUser, resetAuthUsers, serviceClient, signInAs, uniqueEmail } from "./setup.js";

/**
 * 20260930000000 finance: the ledger, balances and reimbursements are
 * exec-only; any member can ask to be reimbursed and attach receipts, and
 * sees only their own requests; budgets count spending from the ledger and
 * stay per-subteam.
 */

const pm = () => serviceClient().schema("pm");
const fin = () => serviceClient().schema("finance");
const pur = () => serviceClient().schema("purchasing");

async function subteam(name: string, code: string): Promise<string> {
  const { data, error } = await pm().from("subteams")
    .upsert({ name, code, slug: code.toLowerCase() }, { onConflict: "code" }).select("id").single();
  if (error) throw error;
  return data!.id;
}
async function project(code: string): Promise<string> {
  const { data, error } = await pm().from("projects")
    .upsert({ name: code, car_year: 2027, car_code: code }, { onConflict: "car_code" }).select("id").single();
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
  return { user, client, f: client.schema("finance"), p: client.schema("purchasing") };
}

async function resetFinance(): Promise<void> {
  const all = (t: string) => fin().from(t).delete().gte("id", 0);
  await pur().from("items").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await pur().from("budget_lines").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await pur().from("seasons").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await pur().from("notifications").delete().gte("id", 0);
  await all("imports");
  await fin().from("vendors").delete().neq("name", "");
  await all("reimbursement_receipts");
  await all("reimbursements");
  await all("evidence");
  await all("balance_entries");
  await all("transactions");
  await all("statements");
  await fin().from("accounts").update({ paid_from_account_id: null }).gte("id", 0);
  await all("accounts");
  await fin().from("discrepancy_resolutions").delete().neq("key", "");
  for (const bucket of ["receipts", "finance-docs"]) {
    const { data: objs } = await serviceClient().storage.from(bucket).list("", { limit: 1000 });
    for (const folder of objs ?? []) {
      const { data: files } = await serviceClient().storage.from(bucket).list(folder.name);
      if (files?.length) await serviceClient().storage.from(bucket).remove(files.map((f) => `${folder.name}/${f.name}`));
    }
  }
}

async function accounts() {
  const { data: checking } = await fin().from("accounts").insert({ name: "Chase Checking", kind: "checking", last4: "0001" }).select("id").single();
  const { data: card } = await fin().from("accounts").insert({
    name: "SAE card", kind: "credit_card", last4: "0000", credit_limit_cents: 500000, paid_from_account_id: checking!.id,
  }).select("id").single();
  return { checking: checking!.id as number, card: card!.id as number };
}

describe("finance", () => {
  let daq: string, eng: string, ic: string;

  beforeEach(async () => {
    await resetAuthUsers();
    await resetFinance();
    daq = await subteam("Data AQ", "DAQ");
    eng = await subteam("Engine", "ENG");
    ic = await project("SDM27");
  });
  afterEach(async () => {
    await resetFinance();
    await resetAuthUsers();
  });

  it("only execs can see or change the ledger and balances", async () => {
    const { checking } = await accounts();
    await fin().from("transactions").insert({ account_id: checking, date: "2026-09-01", amount_cents: -5000, kind: "withdrawal" });
    const cfo = await person("cfo", "executive");
    const member = await person("member", "engineer", daq);
    const lead = await person("lead", "lead", daq);

    for (const table of ["accounts", "transactions", "balance_entries", "statements", "evidence", "events"]) {
      expect((await member.f.from(table).select("*")).data ?? [], table).toHaveLength(0);
      expect((await lead.f.from(table).select("*")).data ?? [], table).toHaveLength(0);
    }
    expect((await cfo.f.from("transactions").select("id")).data).toHaveLength(1);

    const { error: insErr } = await member.f.from("transactions")
      .insert({ account_id: checking, date: "2026-09-02", amount_cents: -1, kind: "charge" });
    expect(insErr).not.toBeNull();
    const { error: balErr } = await member.f.from("balance_entries").insert({ account_id: checking, as_of: "2026-09-02", balance_cents: 1 });
    expect(balErr).not.toBeNull();
    const { error: okErr } = await cfo.f.from("balance_entries").insert({ account_id: checking, as_of: "2026-09-02", balance_cents: 845000 });
    expect(okErr).toBeNull();
  });

  it("balances are append-only and statement lines can't be deleted", async () => {
    const { checking } = await accounts();
    const cfo = await person("cfo", "executive");
    const { data: e } = await cfo.f.from("balance_entries").insert({ account_id: checking, as_of: "2026-09-02", balance_cents: 100 }).select("id").single();
    await cfo.f.from("balance_entries").update({ balance_cents: 999 }).eq("id", e!.id);
    await cfo.f.from("balance_entries").delete().eq("id", e!.id);
    const { data: still } = await fin().from("balance_entries").select("balance_cents").eq("id", e!.id).single();
    expect(still!.balance_cents).toBe(100);

    const { data: stmt } = await fin().from("transactions").insert({
      account_id: checking, date: "2026-09-01", amount_cents: -100, kind: "charge", source: "chase-pdf", source_key: "x1",
    }).select("id").single();
    const { data: manual } = await cfo.f.from("transactions").insert({
      account_id: checking, date: "2026-09-03", amount_cents: -2500, kind: "check", reference: "1043",
    }).select("id").single();
    await cfo.f.from("transactions").delete().in("id", [stmt!.id, manual!.id]);
    const { data: left } = await fin().from("transactions").select("id");
    expect(left!.map((r) => r.id)).toEqual([stmt!.id]);

    const { data: history } = await cfo.f.from("events").select("entity,field").eq("entity", "transactions");
    expect(history!.map((h) => h.field)).toEqual(expect.arrayContaining(["*created*", "*deleted*"]));
  });

  it("any member can ask to be reimbursed with receipts; only they and the execs can see it", async () => {
    await accounts();
    const cfo = await person("cfo", "executive");
    const alex = await person("alex", "engineer", daq);
    const other = await person("other", "engineer", eng);

    const { error: badErr } = await alex.f.rpc("request_reimbursement", { p_amount_cents: 0, p_reason: "hotel" });
    expect(badErr?.message).toMatch(/amount/);
    const { data: rid, error } = await alex.f.rpc("request_reimbursement", {
      p_amount_cents: 21500, p_reason: "Hotel, competition trip", p_project: ic, p_subteam: daq,
    });
    expect(error).toBeNull();

    // receipt: the owner uploads while the request is being reviewed
    const path = `${rid}/abc-receipt.pdf`;
    const up = await alex.client.storage.from("receipts").upload(path, new Uint8Array([37, 80, 68, 70]), { contentType: "application/pdf" });
    expect(up.error).toBeNull();
    expect((await alex.f.from("reimbursement_receipts").insert({
      reimbursement_id: rid, object_path: path, file_name: "receipt.pdf", content_type: "application/pdf", size_bytes: 4,
    })).error).toBeNull();

    // someone else can't see the request, the receipt row, or the file, and can't upload into it
    expect((await other.f.from("reimbursements").select("id")).data ?? []).toHaveLength(0);
    expect((await other.f.from("reimbursement_receipts").select("id")).data ?? []).toHaveLength(0);
    expect((await other.client.storage.from("receipts").download(path)).error).not.toBeNull();
    expect((await other.client.storage.from("receipts").upload(`${rid}/evil.pdf`, new Uint8Array([1]), { contentType: "application/pdf" })).error).not.toBeNull();

    // the owner and the execs can
    expect((await alex.f.from("reimbursements").select("status")).data).toEqual([{ status: "requested" }]);
    expect((await cfo.client.storage.from("receipts").download(path)).error).toBeNull();
    const { data: notes } = await cfo.p.from("notifications").select("message");
    expect(notes![0].message).toContain(alex.user.email);
    expect(notes![0].message).toContain("$215.00");

    // only execs decide; once decided the owner can't change receipts or withdraw
    expect((await alex.f.rpc("decide_reimbursement", { p_id: rid, p_decision: "approve" })).error?.message).toMatch(/only execs/);
    expect((await cfo.f.rpc("decide_reimbursement", { p_id: rid, p_decision: "approve" })).error).toBeNull();
    expect((await alex.client.storage.from("receipts").upload(`${rid}/late.pdf`, new Uint8Array([1]), { contentType: "application/pdf" })).error).not.toBeNull();
    expect((await alex.f.rpc("withdraw_reimbursement", { p_id: rid })).error).not.toBeNull();
    const { data: told } = await alex.p.from("notifications").select("message");
    expect(told!.some((n) => /approved/.test(n.message))).toBe(true);
  });

  it("paying by check writes one uncashed check per person into the ledger", async () => {
    const { checking } = await accounts();
    const cfo = await person("cfo", "executive");
    const { data: rows } = await cfo.f.from("reimbursements").insert([
      { person_name: "Alex", amount_cents: 30000, reason: "shop vac" },
      { person_name: "Alex", amount_cents: 16100, reason: "gas" },
      { person_name: "Sam", amount_cents: 21500, reason: "hotel" },
    ]).select("id,person_name");
    const alexRows = rows!.filter((r) => r.person_name === "Alex").map((r) => r.id);
    const all = rows!.map((r) => r.id);

    expect((await cfo.f.rpc("pay_reimbursements", { p_ids: all, p_check_number: "1050", p_add_check: true })).error?.message)
      .toMatch(/one person/);
    const { data: txnId, error } = await cfo.f.rpc("pay_reimbursements", {
      p_ids: alexRows, p_paid_date: "2026-09-20", p_check_number: "1050", p_add_check: true,
    });
    expect(error).toBeNull();
    const { data: check } = await cfo.f.from("transactions").select("*").eq("id", txnId).single();
    expect(check).toMatchObject({ account_id: checking, kind: "check", amount_cents: -46100, reference: "1050", cleared_date: null });
    const { data: paid } = await cfo.f.from("reimbursements").select("status,check_txn_id").in("id", alexRows);
    expect(paid!.every((r) => r.status === "paid" && r.check_txn_id === txnId)).toBe(true);
  });

  it("budgets count ledger spending by split, never twice, and stay per-subteam", async () => {
    const { card } = await accounts();
    const cfo = await person("cfo", "executive");
    const daqEng = await person("daqeng", "engineer", daq);
    const engEng = await person("engeng", "engineer", eng);
    const { data: season } = await pur().from("seasons").insert({ name: "2026-27", is_current: true }).select("id").single();
    for (const [name, st, cents] of [["Data AQ", daq, 420000], ["Engine", eng, 850000]] as const) {
      await cfo.p.rpc("upsert_budget_line", { p_id: null, p_season: season!.id, p_project: ic, p_name: name, p_amount_cents: cents, p_subteams: [st] });
    }

    // a $100 card charge split $60 DAQ / $40 Engine, and a $2.57 refund to Engine
    const { data: charge } = await cfo.f.from("transactions").insert({ account_id: card, date: "2026-09-10", amount_cents: -10000, kind: "charge", vendor: "Mouser" }).select("id").single();
    const { error: badSplit } = await cfo.f.rpc("set_allocations", { p_txn: charge!.id, p_allocations: [{ project_id: ic, subteam_id: daq, amount_cents: 6000 }] });
    expect(badSplit?.message).toMatch(/add up to \$100.00/);
    expect((await cfo.f.rpc("set_allocations", { p_txn: charge!.id, p_allocations: [
      { project_id: ic, subteam_id: daq, amount_cents: 6000 }, { project_id: ic, subteam_id: eng, amount_cents: 4000 }] })).error).toBeNull();
    const { data: refund } = await cfo.f.from("transactions").insert({ account_id: card, date: "2026-09-12", amount_cents: 257, kind: "credit" }).select("id").single();
    await cfo.f.rpc("set_allocations", { p_txn: refund!.id, p_allocations: [{ project_id: ic, subteam_id: eng, amount_cents: 257 }] });

    // an ordered DAQ item not yet matched is committed; once linked it counts through the ledger only
    const { data: ids } = await cfo.p.rpc("add_items", { p_project: ic, p_subteam: daq, p_rows: [{ title: "ADC", total_estimate_cents: 6000 }] });
    await cfo.p.rpc("set_status", { p_ids: ids, p_status: "APPROVED" });
    await cfo.p.rpc("record_order", { p_ids: ids, p_order_id: "50112233", p_payment: "Team card", p_total_cents: 6000 });
    let rows = (await cfo.p.rpc("budget_rows")).data as any[];
    expect(rows.find((r) => r.name === "Data AQ")).toMatchObject({ spent_cents: 6000, committed_cents: 6000 });
    await cfo.f.rpc("link_item", { p_item: ids[0], p_txn: charge!.id });
    rows = (await cfo.p.rpc("budget_rows")).data as any[];
    expect(rows.find((r) => r.name === "Data AQ")).toMatchObject({ spent_cents: 6000, committed_cents: 0 });
    expect(rows.find((r) => r.name === "Engine")).toMatchObject({ spent_cents: 4000 - 257 });

    // each member only gets their own subteam's line
    const daqRows = (await daqEng.p.rpc("budget_rows")).data as any[];
    expect(daqRows.map((r) => r.name)).toEqual(["Data AQ"]);
    const engRows = (await engEng.p.rpc("budget_rows")).data as any[];
    expect(engRows.map((r) => r.name)).toEqual(["Engine"]);
    // and can't read the budget lines table directly
    expect((await daqEng.p.from("budget_lines").select("id")).data ?? []).toHaveLength(0);
  });

  it("only execs upload statements; a file imports once and each line once; checks clear and autopays confirm", async () => {
    const { checking, card } = await accounts();
    const cfo = await person("cfo", "executive");
    const lead = await person("lead", "lead", daq);
    const check = (await cfo.f.from("transactions").insert({ account_id: checking, date: "2026-09-15", amount_cents: -25000, kind: "check", reference: "1043" }).select("id").single()).data!;
    await fin().from("transactions").insert([
      { account_id: checking, date: "2026-10-23", amount_cents: -5966, kind: "transfer", status: "expected", transfer_group: "autopay:0000:2026-09-25" },
      { account_id: card, date: "2026-10-23", amount_cents: 5966, kind: "transfer", status: "expected", transfer_group: "autopay:0000:2026-09-25" },
    ]);
    const args = {
      p_file: { sha256: "abc", file_name: "Chase.csv", format: "chase-checking", account_id: checking },
      p_rows: [{ account_id: checking, date: "2026-09-21", amount_cents: 50000, kind: "deposit", category: "Dues", source_key: "k1", description: "Deposit" }],
      p_clears: [{ txn_id: check.id, cleared_date: "2026-09-22" }],
      p_confirms: [{ transfer_group: "autopay:0000:2026-09-25", date: "2026-10-22" }],
      p_balances: [{ account_id: checking, as_of: "2026-09-22", balance_cents: 1200000, note: "", source_key: "b1" }],
    };
    expect((await lead.f.rpc("import_transactions", args)).error?.message).toMatch(/only execs/);
    const { data: res, error } = await cfo.f.rpc("import_transactions", args);
    expect(error).toBeNull();
    expect(res).toMatchObject({ added: 1, cleared: 1, confirmed: 2, balances: 1 });
    expect((await cfo.f.rpc("import_transactions", args)).error?.message).toMatch(/already imported/);
    // the same line in another file is skipped
    const again = await cfo.f.rpc("import_transactions", { ...args, p_file: { ...args.p_file, sha256: "def" }, p_clears: [], p_confirms: [], p_balances: [] });
    expect(again.data).toMatchObject({ added: 0 });
    const { data: rows } = await cfo.f.from("transactions").select("kind,status,cleared_date,date").eq("account_id", checking).order("id");
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "check", cleared_date: "2026-09-22" }),
      expect.objectContaining({ kind: "transfer", status: "posted", date: "2026-10-22" }),
    ]));
    const { data: bal } = await cfo.f.from("balance_entries").select("entered_by_name,confirmed").eq("source_key", "b1").single();
    expect(bal).toEqual({ entered_by_name: "Bank export", confirmed: true });
  });

  it("invoice files and the upload log are exec-only; the vendor list is readable by members", async () => {
    const { card } = await accounts();
    const cfo = await person("cfo", "executive");
    const member = await person("member", "engineer", daq);
    await fin().from("vendors").insert({ name: "Mouser", aliases: ["Mouser Electronics"], merchant_pattern: "MOUSER", default_category: "Parts & materials" });
    expect((await member.f.from("vendors").select("name")).data).toEqual([{ name: "Mouser" }]);
    expect((await member.f.from("vendors").insert({ name: "Evil" })).error).not.toBeNull();

    const t = (await fin().from("transactions").insert({ account_id: card, date: "2026-09-10", amount_cents: -1852, kind: "charge" }).select("id").single()).data!;
    const path = `${t.id}/x-invoice.pdf`;
    expect((await member.client.storage.from("finance-docs").upload(path, new Uint8Array([1]), { contentType: "application/pdf" })).error).not.toBeNull();
    expect((await cfo.client.storage.from("finance-docs").upload(path, new Uint8Array([37, 80, 68, 70]), { contentType: "application/pdf" })).error).toBeNull();
    expect((await member.client.storage.from("finance-docs").download(path)).error).not.toBeNull();
    expect((await cfo.client.storage.from("finance-docs").download(path)).error).toBeNull();
    expect((await member.f.from("imports").select("id")).data ?? []).toHaveLength(0);
  });

  it("a budget line's breakdown lists its parts and charges, in the caller's scope only", async () => {
    const { card } = await accounts();
    const cfo = await person("cfo", "executive");
    const daqEng = await person("daqeng", "engineer", daq);
    const { data: season } = await pur().from("seasons").insert({ name: "2026-27", is_current: true }).select("id").single();
    await cfo.p.rpc("upsert_budget_line", { p_id: null, p_season: season!.id, p_project: ic, p_name: "Data AQ", p_amount_cents: 420000, p_subteams: [daq] });
    const charge = (await fin().from("transactions").insert({ account_id: card, date: "2026-09-10", amount_cents: -1852, kind: "charge", vendor: "Mouser" }).select("id").single()).data!;
    await cfo.f.rpc("set_allocations", { p_txn: charge.id, p_allocations: [{ project_id: ic, subteam_id: daq, amount_cents: 1852 }] });
    await daqEng.p.rpc("add_items", { p_project: ic, p_subteam: daq, p_rows: [{ title: "ESP32", total_estimate_cents: 5470 }] });
    // team-wide spending (no car) on another subteam
    const team = (await fin().from("transactions").insert({ account_id: card, date: "2026-09-11", amount_cents: -982, kind: "charge", vendor: "Amazon" }).select("id").single()).data!;
    await cfo.f.rpc("set_allocations", { p_txn: team.id, p_allocations: [{ project_id: null, subteam_id: eng, amount_cents: 982 }] });

    const mine = (await daqEng.p.rpc("budget_detail", { p_project: ic, p_subteams: [daq] })).data as any[];
    expect(mine.map((r) => [r.bucket, r.source, r.label, r.cents])).toEqual([["spent", "ledger", "Mouser", 1852], ["planned", "part", "ESP32", 5470]]);
    expect(mine[0].txn_id).toBeNull();   // members never get a ledger link
    expect((await daqEng.p.rpc("budget_detail", { p_project: null, p_subteams: [eng] })).data).toEqual([]);
    const exec = (await cfo.p.rpc("budget_detail", { p_project: null, p_subteams: [eng] })).data as any[];
    expect(exec).toEqual([expect.objectContaining({ label: "Amazon", cents: 982, txn_id: team.id })]);
  });
});
