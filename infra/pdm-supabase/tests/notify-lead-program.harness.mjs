// Applies 20261007000000_pm_lead_program_scope.sql to a throwaway PGlite (real
// Postgres, compiled to WASM) over Supabase-shaped stubs of the tables it
// touches, then drives the REAL enqueue triggers and checks which lead each
// task notification resolves. Run it after touching that migration, BEFORE
// applying anything to prod.
//
//   npm i @electric-sql/pglite      # not a repo dependency; install ad hoc
//   node infra/pdm-supabase/tests/notify-lead-program.harness.mjs
//   # or point at an existing install:
//   PGLITE=/abs/path/node_modules/@electric-sql/pglite/dist/index.js node ...
//
// The scenario is the 2026-10-07 report: Chassis is shared by the IC and EV
// cars, Tim leads IC Chassis, and EV Chassis tasks were pinging Tim.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const { PGlite } = await import(
  process.env.PGLITE ? pathToFileURL(process.env.PGLITE).href : "@electric-sql/pglite"
);

const MIGRATION = new URL("../supabase/migrations/20261007000000_pm_lead_program_scope.sql", import.meta.url);

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
}

// people
const TIM = "00000000-0000-0000-0000-00000000000a";   // IC Chassis lead
const EVL = "00000000-0000-0000-0000-00000000000b";   // EV Chassis lead
const BOTH = "00000000-0000-0000-0000-00000000000c";  // untagged Suspension lead
const ICS = "00000000-0000-0000-0000-00000000000d";   // IC-only Suspension lead (granted AFTER the untagged one)
const ADMIN = "00000000-0000-0000-0000-00000000000e"; // org.grant_roles
const RANDO = "00000000-0000-0000-0000-00000000000f"; // engineer, no grant caps
// structure
const CHA = "10000000-0000-0000-0000-000000000001";
const SUS = "10000000-0000-0000-0000-000000000002";
const BRK = "10000000-0000-0000-0000-000000000003";
const P_IC = "20000000-0000-0000-0000-000000000001";
const P_EV = "20000000-0000-0000-0000-000000000002";
const P_NONE = "20000000-0000-0000-0000-000000000003";
const R_LEAD = "30000000-0000-0000-0000-000000000001";
const R_ENG = "30000000-0000-0000-0000-000000000002";
const R_ADMIN = "30000000-0000-0000-0000-000000000003";

const db = await PGlite.create();

// ---- Supabase-shaped stubs (columns the migration + triggers touch) --------
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema auth;
  create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb,
                           created_at timestamptz default now());
  create function auth.uid() returns uuid language sql stable as
    $fn$ select nullif(current_setting('test.uid', true), '')::uuid $fn$;

  create schema pm;
  create table pm.subteams (id uuid primary key, name text);
  create table pm.projects (id uuid primary key, name text, program text check (program in ('ic','ev')));
  create table pm.roles (id uuid primary key, key text unique, label text, tag text, scope text, sort_order int default 0);
  create table pm.role_capabilities (role_id uuid, capability_key text, primary key (role_id, capability_key));
  -- verbatim from 20260617000000
  create table pm.role_memberships (
    user_id    uuid not null references auth.users(id) on delete cascade,
    role_id    uuid not null references pm.roles(id) on delete cascade,
    subteam_id uuid references pm.subteams(id) on delete cascade,
    granted_by uuid,
    granted_at timestamptz not null default now()
  );
  create unique index role_memberships_uniq
    on pm.role_memberships (user_id, role_id, coalesce(subteam_id, '00000000-0000-0000-0000-000000000000'::uuid));
  create table pm.subteam_memberships (user_id uuid, subteam_id uuid, role text, joined_at timestamptz default now());
  -- verbatim from 20260617000000 / 20260617002000
  create function pm.has_capability(uid uuid, cap text, stid uuid default null)
  returns boolean language sql stable security definer set search_path = pm, public as $$
    select exists (select 1 from pm.role_memberships m join pm.role_capabilities rc on rc.role_id = m.role_id
                    where m.user_id = uid and rc.capability_key = cap
                      and (m.subteam_id is null or (stid is not null and m.subteam_id = stid)));
  $$;
  create function pm._user_caps(uid uuid, stid uuid)
  returns setof text language sql stable security definer set search_path = pm, public as $$
    select distinct rc.capability_key from pm.role_memberships m join pm.role_capabilities rc on rc.role_id = m.role_id
     where m.user_id = uid and (m.subteam_id is null or (stid is not null and m.subteam_id = stid));
  $$;
  create table pm.tasks (id uuid primary key default gen_random_uuid(), title text, project_id uuid, owner_id uuid,
    subteam_id uuid, status text, due_date date, priority text, start_date date, type text, mrl int,
    subsystem_id uuid, description text);
  create table pm.task_comments (id uuid primary key default gen_random_uuid(), task_id uuid, author_id uuid,
    body text, kind text default 'comment');

  create schema notify;
  create table notify.outbox (
    id bigint generated always as identity primary key, source text not null default 'pm', event_id uuid,
    project_id uuid, actor_id uuid, action text, target_type text, target_id uuid, target_name text,
    summary text not null, edit_count integer not null default 1, coalesce_key text not null,
    status text not null default 'pending', send_after timestamptz not null default now(),
    actor_email text, owner_email text, lead_email text);
  create unique index notify_outbox_coalesce_pending on notify.outbox (coalesce_key) where status = 'pending';
  create function notify.status_label(s text) returns text language sql as $$ select s $$;
  create function notify.person_name(u uuid) returns text language sql as $$ select u::text $$;
  -- the pre-fix resolver, so the migration's drop is exercised
  create function notify.lead_email(p_subteam uuid) returns text language sql as $$ select null::text $$;
  -- placeholder trigger fns so the triggers can be wired before the migration replaces them
  create function notify.enqueue_from_task() returns trigger language plpgsql as $$ begin return null; end $$;
  create function notify.enqueue_from_comment() returns trigger language plpgsql as $$ begin return null; end $$;
  create trigger trg_notify_task after insert or delete or update on pm.tasks
    for each row execute function notify.enqueue_from_task();
  create trigger trg_notify_comment after insert on pm.task_comments
    for each row execute function notify.enqueue_from_comment();

  insert into auth.users (id, email) values
    ('${TIM}', 'tim@x'), ('${EVL}', 'ev-lead@x'), ('${BOTH}', 'both@x'), ('${ICS}', 'ic-sus@x'),
    ('${ADMIN}', 'admin@x'), ('${RANDO}', 'rando@x');
  insert into pm.subteams values ('${CHA}', 'Chassis'), ('${SUS}', 'Suspension'), ('${BRK}', 'Brakes');
  insert into pm.projects values ('${P_IC}', 'SDM27', 'ic'), ('${P_EV}', 'SDM27e', 'ev'), ('${P_NONE}', 'Misc', null);
  insert into pm.roles values ('${R_LEAD}', 'lead', 'Lead', null, 'subteam', 2),
                              ('${R_ENG}', 'engineer', 'Engineer', null, 'subteam', 3),
                              ('${R_ADMIN}', 'admin', 'Admin', null, 'org', 1);
  insert into pm.role_capabilities values ('${R_LEAD}', 'pm.grant_subteam_roles'), ('${R_LEAD}', 'pm.edit'),
    ('${R_ENG}', 'pm.edit'), ('${R_ADMIN}', 'org.grant_roles'), ('${R_ADMIN}', 'pm.grant_subteam_roles'),
    ('${R_ADMIN}', 'pm.edit');
  -- Tim was granted Chassis lead FIRST (that's why he won every tie before).
  insert into pm.role_memberships (user_id, role_id, subteam_id, granted_at) values
    ('${TIM}',  '${R_LEAD}', '${CHA}', now() - interval '30 days'),
    ('${EVL}',  '${R_LEAD}', '${CHA}', now() - interval '10 days'),
    ('${ICS}',  '${R_LEAD}', '${SUS}', now() - interval '5 days'),  -- newer than BOTH
    ('${BOTH}', '${R_LEAD}', '${SUS}', now() - interval '10 days'),
    ('${ADMIN}', '${R_ADMIN}', null,   now() - interval '90 days'),
    ('${RANDO}', '${R_ENG}', '${CHA}', now() - interval '5 days');
`);

const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const asUser = (uid) => db.query(`select set_config('test.uid', $1, false)`, [uid ?? ""]);
const lead = async (st, proj) => (await one(`select notify.lead_email($1, $2) as e`, [st, proj])).e;

// Pre-fix behaviour, for the record: earliest-granted Chassis lead = Tim, for any car.

// ---- A. the migration applies ---------------------------------------------
try {
  await db.exec(readFileSync(MIGRATION, "utf8"));
  check("migration applies cleanly over the stubs", true);
} catch (e) {
  check("migration applies cleanly", false, `\n       ${e.message}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(1);
}
check("1-arg notify.lead_email is dropped",
  (await one(`select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'notify' and p.proname = 'lead_email'`)).n === 1);

// ---- B. untagged everywhere = exactly today's behaviour --------------------
check("untagged: EV Chassis still resolves the earliest lead (unchanged until tagged)",
  (await lead(CHA, P_EV)) === "tim@x");

// ---- C. tagging via the RPC ------------------------------------------------
await asUser(ADMIN);
await db.query(`select pm.set_role_program($1, 'lead', $2, 'ic')`, [TIM, CHA]);
await db.query(`select pm.set_role_program($1, 'lead', $2, 'ev')`, [EVL, CHA]);
await db.query(`select pm.set_role_program($1, 'lead', $2, 'ic')`, [ICS, SUS]);
check("set_role_program writes the tag",
  (await one(`select program from pm.role_memberships where user_id = $1 and subteam_id = $2`, [TIM, CHA])).program === "ic");

const rejects = async (name, sql, params, code) => {
  try { await db.query(sql, params); check(name, false, "(no error)"); }
  catch (e) { check(name, !code || e.code === code, `got ${e.code} ${e.message}`); }
};
await asUser(RANDO);
await rejects("an engineer cannot retag a lead grant",
  `select pm.set_role_program($1, 'lead', $2, null)`, [TIM, CHA], "42501");
await asUser(null);
await rejects("anonymous caller is refused",
  `select pm.set_role_program($1, 'lead', $2, null)`, [TIM, CHA], "42501");
await asUser(ADMIN);
await rejects("invalid program value is refused",
  `select pm.set_role_program($1, 'lead', $2, 'hybrid')`, [TIM, CHA], "22023");
await rejects("org-scoped role cannot be tagged",
  `select pm.set_role_program($1, 'admin', null, 'ic')`, [ADMIN], "22023");
await rejects("tagging a grant that doesn't exist errors",
  `select pm.set_role_program($1, 'lead', $2, 'ev')`, [TIM, BRK], "P0002");
const acl = await one(`select has_function_privilege('anon', 'pm.set_role_program(uuid,text,uuid,text)', 'execute') as anon,
                              has_function_privilege('authenticated', 'pm.set_role_program(uuid,text,uuid,text)', 'execute') as authd,
                              has_function_privilege('authenticated', 'notify.lead_email(uuid,uuid)', 'execute') as lead`);
check("set_role_program: authenticated yes, anon no", acl.authd === true && acl.anon === false, JSON.stringify(acl));
check("notify.lead_email is not callable by clients", acl.lead === false);

// ---- D. resolution rules ----------------------------------------------------
check("EV Chassis -> EV-tagged lead (not Tim)", (await lead(CHA, P_EV)) === "ev-lead@x");
check("IC Chassis -> Tim", (await lead(CHA, P_IC)) === "tim@x");
check("no-program project -> earliest lead, as before", (await lead(CHA, P_NONE)) === "tim@x");
check("EV Suspension -> untagged lead when no EV-tagged one exists (IC lead skipped)",
  (await lead(SUS, P_EV)) === "both@x");
check("IC Suspension -> IC-tagged lead outranks an OLDER untagged one",
  (await lead(SUS, P_IC)) === "ic-sus@x");
await db.query(`update pm.role_memberships set program = 'ic' where user_id = $1 and subteam_id = $2`, [BOTH, SUS]);
check("EV Suspension with ONLY IC-tagged leads -> null (never the other car's lead)",
  (await lead(SUS, P_EV)) === null);
await db.query(`insert into pm.subteam_memberships values ($1, $2, 'lead', now() - interval '400 days')`, [TIM, SUS]);
check("legacy subteam_memberships lead is the last resort",
  (await lead(SUS, P_EV)) === "tim@x");
// both Suspension leads are IC-tagged now -> earliest-granted of them, never the legacy row
check("legacy lead never outranks a tagged org lead", (await lead(SUS, P_IC)) === "both@x");
check("no subteam -> null", (await lead(null, P_EV)) === null);

// ---- E. the real triggers ---------------------------------------------------
await asUser(RANDO);
const tEv = (await one(`insert into pm.tasks (title, project_id, subteam_id, status) values ('EV frame', $1, $2, 'todo') returning id`, [P_EV, CHA])).id;
const tIc = (await one(`insert into pm.tasks (title, project_id, subteam_id, status) values ('IC frame', $1, $2, 'todo') returning id`, [P_IC, CHA])).id;
const outLead = async (key) => (await one(`select lead_email from notify.outbox where coalesce_key = $1`, [key]))?.lead_email;
check("task trigger: EV Chassis task enqueues the EV lead", (await outLead(`pm:${tEv}`)) === "ev-lead@x");
check("task trigger: IC Chassis task enqueues Tim", (await outLead(`pm:${tIc}`)) === "tim@x");
await db.query(`update pm.tasks set status = 'done' where id = $1`, [tEv]);
check("task trigger: an EV status change still pings the EV lead (coalesced row)",
  (await outLead(`pm:${tEv}`)) === "ev-lead@x");
await db.query(`insert into pm.task_comments (task_id, author_id, body) values ($1, $2, 'looks good')`, [tEv, RANDO]);
check("comment trigger: comment on an EV Chassis task pings the EV lead",
  (await outLead(`pm-comment:${tEv}:${RANDO}`)) === "ev-lead@x");

// ---- F. the Org UI read ------------------------------------------------------
await asUser(ADMIN);
const people = (await db.query(`select * from pm.list_people()`)).rows;
const timRoles = people.find((p) => p.user_id === TIM).roles;
check("list_people reports the program on each role", timRoles[0]?.program === "ic", JSON.stringify(timRoles));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
