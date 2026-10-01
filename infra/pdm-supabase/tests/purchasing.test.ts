import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestUser, resetAuthUsers, serviceClient, signInAs, uniqueEmail } from "./setup.js";

/**
 * 20261001000000 purchasing: any member can request parts for their own
 * subteam; only execs approve (two of them, requester excluded) and record
 * orders; everyone sees the parts list, only their own subteam's budget.
 */

const pm = () => serviceClient().schema("pm");
const pur = () => serviceClient().schema("purchasing");

async function subteam(name: string, code: string): Promise<string> {
  const { data, error } = await pm()
    .from("subteams")
    .upsert({ name, code, slug: code.toLowerCase() }, { onConflict: "code" })
    .select("id")
    .single();
  if (error) throw error;
  return data!.id;
}

async function project(code: string): Promise<string> {
  const { data, error } = await pm()
    .from("projects")
    .upsert({ name: code, car_year: 2027, car_code: code }, { onConflict: "car_code" })
    .select("id")
    .single();
  if (error) throw error;
  return data!.id;
}

async function grant(userId: string, roleKey: string, subteamId: string | null = null): Promise<void> {
  const { data: role, error } = await pm().from("roles").select("id").eq("key", roleKey).single();
  if (error) throw error;
  const { error: e2 } = await pm()
    .from("role_memberships")
    .insert({ user_id: userId, role_id: role!.id, subteam_id: subteamId });
  if (e2) throw e2;
}

async function member(prefix: string, roleKey: string, subteamId: string | null = null) {
  const email = uniqueEmail(prefix);
  const user = await createTestUser(email);
  await grant(user.id, roleKey, subteamId);
  const client = (await signInAs(email)).schema("purchasing");
  return { user, client };
}

async function resetPurchasing(): Promise<void> {
  // items cascade to allocations, approvals, notifications
  await pur().from("items").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await pur().from("events").delete().gte("id", 0);
  await pur().from("budget_lines").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await pur().from("seasons").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await pur().from("settings").update({ value: "" }).eq("key", "delivery_person_id");
}

/** Two different execs approve an item that is waiting (READY). */
async function approveTwice(itemId: string): Promise<void> {
  for (const who of ["appr1", "appr2"]) {
    const exec = await member(who, "executive");
    const { error } = await exec.client.rpc("decide", { p_id: itemId, p_decision: "approve" });
    if (error) throw error;
  }
}

describe("purchasing", () => {
  let daq: string, aero: string, ic: string;

  beforeEach(async () => {
    await resetAuthUsers();
    await resetPurchasing();
    daq = await subteam("Data AQ", "DAQ");
    aero = await subteam("Aero Design", "AED");
    ic = await project("SDM27");
  });
  afterEach(async () => {
    await resetPurchasing();
    await resetAuthUsers();
  });

  it("an engineer requests for their own subteam; execs are told who asked", async () => {
    const exec = await member("exec", "executive");
    const eng = await member("eng", "engineer", daq);

    const { data: ids, error } = await eng.client.rpc("add_items", {
      p_project: ic, p_subteam: daq, p_ready: true,
      p_rows: [
        { title: "ADC128S102", quantity: 2, unit_price_cents: 926, part_number: "ADC128S102CIMTX/NOPB" },
        { title: "TVS diode", quantity: 16, unit_price_cents: 31 },
        { title: "" },  // blank names are skipped
      ],
    });
    expect(error).toBeNull();
    expect(ids).toHaveLength(2);

    const { data: items } = await eng.client.from("items").select("title,status,total_estimate_cents,requester_name").order("code");
    expect(items!.map((i) => [i.title, i.status, i.total_estimate_cents])).toEqual([
      ["ADC128S102", "READY", 1852], ["TVS diode", "READY", 496],
    ]);

    // one notification for the batch, naming the requester
    const { data: notes } = await (await signInAs(exec.user.email!)).schema("purchasing").from("notifications").select("message");
    expect(notes).toHaveLength(1);
    expect(notes![0].message).toContain(eng.user.email);
  });

  it("everyone sees the whole parts list but only edits their own subteam's", async () => {
    const eng = await member("eng", "engineer", daq);
    const other = await member("other", "engineer", aero);
    const { data: ids } = await eng.client.rpc("add_items", {
      p_project: ic, p_subteam: daq, p_rows: [{ title: "IMU IC" }],
    });

    const { data: seen } = await other.client.from("items").select("id,title");
    expect(seen).toEqual([{ id: ids![0], title: "IMU IC" }]);
    // someone with no team role sees nothing
    const outsiderEmail = uniqueEmail("outsider");
    await createTestUser(outsiderEmail);
    const { data: none } = await (await signInAs(outsiderEmail)).schema("purchasing").from("items").select("id");
    expect(none ?? []).toHaveLength(0);
    const { error: editErr } = await other.client.rpc("update_item", { p_id: ids![0], p_patch: { title: "hijack" } });
    expect(editErr?.message).toMatch(/own subteam/);
    const { error: addErr } = await other.client.rpc("add_items", { p_project: ic, p_subteam: daq, p_rows: [{ title: "x" }] });
    expect(addErr?.message).toMatch(/own subteam/);
  });

  it("requesters can't approve or fill in order details", async () => {
    const eng = await member("eng", "engineer", daq);
    const { data: ids } = await eng.client.rpc("add_items", {
      p_project: ic, p_subteam: daq, p_ready: true, p_rows: [{ title: "Spark plugs", unit_price_cents: 5249 }],
    });
    const { error: decideErr } = await eng.client.rpc("decide", { p_id: ids![0], p_decision: "approve" });
    expect(decideErr?.message).toMatch(/only execs/);
    const { error: patchErr } = await eng.client.rpc("update_item", { p_id: ids![0], p_patch: { vendor_order_id: "123" } });
    expect(patchErr?.message).toMatch(/only execs/);
    const { error: statusErr } = await eng.client.rpc("set_status", { p_ids: ids, p_status: "APPROVED" });
    expect(statusErr?.message).toMatch(/two exec approvals/);
  });

  it("two execs approve; a requesting exec's own approval doesn't count; one deny stops it", async () => {
    const cfo = await member("cfo", "executive");
    const pres = await member("pres", "executive");
    const chief = await member("chief", "executive");

    const { data: own } = await cfo.client.rpc("add_items", {
      p_project: ic, p_subteam: daq, p_ready: true, p_rows: [{ title: "Logger board" }],
    });
    expect((await cfo.client.rpc("decide", { p_id: own![0], p_decision: "approve" })).data).toBe("READY");
    expect((await pres.client.rpc("decide", { p_id: own![0], p_decision: "approve" })).data).toBe("READY");
    expect((await chief.client.rpc("decide", { p_id: own![0], p_decision: "approve" })).data).toBe("APPROVED");

    const { data: other } = await cfo.client.rpc("add_items", {
      p_project: ic, p_subteam: daq, p_ready: true, p_rows: [{ title: "Welder" }],
    });
    expect((await pres.client.rpc("decide", { p_id: other![0], p_decision: "deny", p_note: "use the shop's" })).data).toBe("DENIED");
  });

  it("an order total is split across items; tracking and delivery notify the delivery person", async () => {
    const cfo = await member("cfo", "cfo");
    const courier = await member("courier", "executive");
    await pur().from("settings").update({ value: courier.user.id }).eq("key", "delivery_person_id");

    const { data: ids } = await cfo.client.rpc("add_items", {
      p_project: ic, p_subteam: daq, p_ready: true, p_rows: [
        { title: "A", total_estimate_cents: 3000 }, { title: "B", total_estimate_cents: 1000 }],
    });
    for (const id of ids!) await approveTwice(id);
    expect((await cfo.client.rpc("record_order", { p_ids: ids, p_order_id: "1", p_payment: "card", p_total_cents: -500 })).error?.message)
      .toMatch(/can't be negative/);
    const { error: orderErr } = await cfo.client.rpc("record_order", {
      p_ids: ids, p_order_id: "50112233", p_payment: "Team card 0000", p_total_cents: 5639,
    });
    expect(orderErr).toBeNull();
    const { data: after } = await cfo.client.from("items").select("status,actual_total_cents").order("code");
    expect(after!.map((i) => i.status)).toEqual(["ORDERED", "ORDERED"]);
    expect(after!.reduce((s, i) => s + i.actual_total_cents, 0)).toBe(5639);

    await cfo.client.rpc("add_tracking", { p_ids: ids, p_number: "1Z 999A A101 2345 6784", p_carrier: "UPS" });
    await cfo.client.rpc("set_status", { p_ids: ids, p_status: "DELIVERED" });
    const { data: notes } = await (await signInAs(courier.user.email!)).schema("purchasing")
      .from("notifications").select("kind,message").order("id");
    expect(notes!.map((n) => n.kind)).toEqual(expect.arrayContaining(["shipped", "delivered"]));
    expect(notes!.find((n) => n.kind === "delivered")!.message).toMatch(/Delivered to your place/);
  });

  it("one exec can't approve, order or ship an unapproved item on their own", async () => {
    const cfo = await member("cfo", "cfo");
    const { data: ids } = await cfo.client.rpc("add_items", {
      p_project: ic, p_subteam: daq, p_ready: true, p_rows: [{ title: "Scope", total_estimate_cents: 50000 }],
    });
    expect((await cfo.client.rpc("set_status", { p_ids: ids, p_status: "APPROVED" })).error?.message).toMatch(/two exec approvals/);
    expect((await cfo.client.rpc("set_status", { p_ids: ids, p_status: "ORDERED" })).error?.message).toMatch(/hasn't been approved/);
    expect((await cfo.client.rpc("record_order", { p_ids: ids, p_order_id: "1", p_payment: "card" })).error?.message)
      .toMatch(/only approved items/);
    expect((await cfo.client.rpc("add_tracking", { p_ids: ids, p_number: "1Z" })).error?.message).toMatch(/only approved items/);
    const { data: still } = await pur().from("items").select("status").eq("id", ids![0]).single();
    expect(still!.status).toBe("READY");
  });

  it("changing a waiting request's cost throws away the approvals it already had", async () => {
    const eng = await member("eng", "engineer", daq);
    const pres = await member("pres", "president");
    const chief = await member("chief", "chief_engineer");
    const { data: ids } = await eng.client.rpc("add_items", {
      p_project: ic, p_subteam: daq, p_ready: true, p_rows: [{ title: "Sensor", quantity: 1, unit_price_cents: 1000 }],
    });
    expect((await pres.client.rpc("decide", { p_id: ids![0], p_decision: "approve" })).data).toBe("READY");
    expect((await eng.client.rpc("update_item", { p_id: ids![0], p_patch: { quantity: 100 } })).error).toBeNull();
    expect((await chief.client.rpc("decide", { p_id: ids![0], p_decision: "approve" })).data).toBe("READY");
    // a note doesn't change what is being bought, so it keeps the approval
    expect((await eng.client.rpc("update_item", { p_id: ids![0], p_patch: { notes: "for the dash" } })).error).toBeNull();
    expect((await pres.client.rpc("decide", { p_id: ids![0], p_decision: "approve" })).data).toBe("APPROVED");
  });

  it("an empty edit can't be used to read an item, and amounts must make sense", async () => {
    const eng = await member("eng", "engineer", daq);
    const outsider = await member("outsider", "engineer", aero);
    const { data: ids } = await eng.client.rpc("add_items", { p_project: ic, p_subteam: daq, p_rows: [{ title: "Secret part" }] });
    const peek = await outsider.client.rpc("update_item", { p_id: ids![0], p_patch: {} });
    expect(peek.error?.message).toMatch(/own subteam/);
    expect(peek.data).toBeNull();
    expect((await eng.client.rpc("update_item", { p_id: ids![0], p_patch: { quantity: -3 } })).error?.message).toMatch(/more than zero/);
    expect((await eng.client.rpc("update_item", { p_id: ids![0], p_patch: { unit_price_cents: -100 } })).error?.message).toMatch(/negative/);
    expect((await eng.client.rpc("add_items", { p_project: ic, p_subteam: daq, p_rows: [{ title: "x", quantity: 0 }] })).error?.message)
      .toMatch(/more than zero/);
  });

  it("budget lines cover several subteams and are only shown in scope", async () => {
    const cfo = await member("cfo", "executive");
    const aem = await subteam("Aero Manufacturing", "AEM");
    const aeroLead = await member("aerolead", "lead", aem);
    const daqEng = await member("daqeng", "engineer", daq);

    const { data: season } = await pur().from("seasons").insert({ name: "2026-27", is_current: true }).select("id").single();
    const { error: lineErr } = await cfo.client.rpc("upsert_budget_line", {
      p_id: null, p_season: season!.id, p_project: ic, p_name: "Aero", p_amount_cents: 268000, p_subteams: [aero, aem],
    });
    expect(lineErr).toBeNull();
    await cfo.client.rpc("add_items", { p_project: ic, p_subteam: aero, p_rows: [{ title: "Resin", total_estimate_cents: 24214 }] });
    await cfo.client.rpc("add_items", { p_project: ic, p_subteam: aem, p_rows: [{ title: "Gloves", total_estimate_cents: 4534 }] });

    const { data: rows } = await aeroLead.client.rpc("budget_rows");
    const aeroRow = rows!.find((r: any) => r.name === "Aero");
    expect(aeroRow.budget_cents).toBe(268000);
    expect(aeroRow.planned_cents).toBe(24214 + 4534);  // both aero subteams roll into one line

    const { data: daqRows } = await daqEng.client.rpc("budget_rows");
    expect((daqRows ?? []).some((r: any) => r.name === "Aero")).toBe(false);
    const { error: setErr } = await aeroLead.client.rpc("upsert_budget_line", {
      p_id: null, p_season: season!.id, p_project: ic, p_name: "x", p_amount_cents: 1, p_subteams: [aem],
    });
    expect(setErr?.message).toMatch(/only execs/);
  });

  it("every change is in the audit trail", async () => {
    const eng = await member("eng", "engineer", daq);
    const { data: ids } = await eng.client.rpc("add_items", { p_project: ic, p_subteam: daq, p_rows: [{ title: "Bolts" }] });
    await eng.client.rpc("update_item", { p_id: ids![0], p_patch: { quantity: 12, unit_price_cents: 100 } });
    const { data: events } = await eng.client.from("events").select("field,old_value,new_value,actor_id").eq("item_id", ids![0]);
    const fields = events!.map((e) => e.field);
    expect(fields).toEqual(expect.arrayContaining(["*created*", "quantity", "unit_price_cents", "total_estimate_cents"]));
    expect(events!.every((e) => e.actor_id === eng.user.id)).toBe(true);
  });
});
