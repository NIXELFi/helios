// Applies 20261031000000_notify_vault_assembly_checkout.sql to a throwaway PGlite
// (real Postgres, compiled to WASM) over Supabase-shaped stubs, then drives the
// REAL trigger, sender and settings RPCs. Run it after touching that migration,
// BEFORE applying anything to prod.
//
//   npm i @electric-sql/pglite      # not a repo dependency; install ad hoc
//   node infra/pdm-supabase/tests/notify-assembly-checkout.harness.mjs
//   # or point at an existing install:
//   PGLITE=/abs/path/node_modules/@electric-sql/pglite/dist/index.js node ...
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const { PGlite } = await import(
  process.env.PGLITE ? pathToFileURL(process.env.PGLITE).href : "@electric-sql/pglite"
);

const MIGRATION = new URL("../supabase/migrations/20261031000000_notify_vault_assembly_checkout.sql", import.meta.url);

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
}

const ADMIN = "00000000-0000-0000-0000-00000000000a";
const ADA = "00000000-0000-0000-0000-00000000000b";
const NOAH = "00000000-0000-0000-0000-00000000000c";
const SDM26 = "10000000-0000-0000-0000-000000000026";
const SDM27 = "10000000-0000-0000-0000-000000000027";
const ASM26 = "20000000-0000-0000-0000-000000000026";
const ASM27 = "20000000-0000-0000-0000-000000000027";
const PART27 = "20000000-0000-0000-0000-000000000001";
const GONE27 = "20000000-0000-0000-0000-000000000002";
const URL26 = "https://hooks.slack.com/triggers/T0/26/abc";
const URL27 = "https://hooks.slack.com/triggers/T0/27/def";

const db = await PGlite.create();

// ---- Supabase-shaped stubs, including the existing bots' objects -------------
await db.exec(`
  create role anon; create role authenticated;
  create schema auth; create schema vault; create schema net; create schema cron; create schema pdm; create schema notify;

  create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('test.uid', true), '')::uuid $$;

  create table vault.secrets (id uuid primary key default gen_random_uuid(), name text unique, secret text, description text);
  create view vault.decrypted_secrets as select id, name, secret as decrypted_secret from vault.secrets;
  create function vault.create_secret(new_secret text, new_name text, new_description text) returns uuid language sql as
    $$ insert into vault.secrets (secret, name, description) values (new_secret, new_name, new_description) returning id $$;
  create function vault.update_secret(secret_id uuid, new_secret text) returns void language sql as
    $$ update vault.secrets set secret = new_secret where id = secret_id $$;

  create table net._http_response (id bigint primary key, status_code int, error_msg text);
  create table net.posts (id bigint generated always as identity primary key, url text, body jsonb);
  create function net.http_post(url text, body jsonb) returns bigint language sql as
    $$ insert into net.posts (url, body) values (url, body) returning id $$;

  create table cron.job (jobname text primary key, schedule text, command text);
  create function cron.schedule(n text, s text, c text) returns bigint language sql as
    $$ insert into cron.job values (n, s, c) on conflict (jobname) do update set schedule = s, command = c returning 1::bigint $$;
  select cron.schedule('helios-notify-dispatch', '30 seconds', 'select notify.dispatch();');

  create table pdm.vaults (id uuid primary key, name text);
  create table pdm.files (id uuid primary key, vault_id uuid references pdm.vaults(id), name text, deleted_at timestamptz);
  create table pdm.locks (id uuid primary key default gen_random_uuid(), file_id uuid references pdm.files(id),
                          user_id uuid, released_at timestamptz);
  create function pdm.is_admin_in(p_vault_id uuid) returns boolean language sql stable as
    $$ select auth.uid() = '${ADMIN}'::uuid $$;

  create function notify.person_name(p_uid uuid) returns text language sql stable security definer set search_path to '' as $$
    select coalesce((select coalesce(nullif(u.raw_user_meta_data->>'display_name', ''), u.email)
                       from auth.users u where u.id = p_uid), 'someone') $$;

  -- The existing bots' queue and sender, which this migration must leave alone.
  create table notify.outbox (id bigint generated always as identity primary key, source text, summary text, status text default 'pending');
  create table notify.deliveries (id bigint generated always as identity primary key, outbox_id bigint);
  create function notify.dispatch() returns void language sql as $$ select 1 $$;
  insert into notify.outbox (source, summary) values ('pm', 'existing pm row');

  insert into auth.users (id, email, raw_user_meta_data) values
    ('${ADMIN}', 'admin@asu.edu', '{}'),
    ('${ADA}', 'ada@asu.edu', '{"display_name":"Ada Lovelace"}'),
    ('${NOAH}', 'noah@asu.edu', '{}');
  insert into pdm.vaults values ('${SDM26}', 'SDM26'), ('${SDM27}', 'SDM27');
  insert into pdm.files values
    ('${ASM26}', '${SDM26}', 'SDM26-Master-Assembly.SLDASM', null),
    ('${ASM27}', '${SDM27}', 'SDM27-Master-Assembly.SLDASM', null),
    ('${PART27}', '${SDM27}', 'upright.SLDPRT', null),
    ('${GONE27}', '${SDM27}', 'deleted.SLDASM', now());
  insert into vault.secrets (name, secret) values
    ('slack_wf_activity_url', 'https://hooks.slack.com/pm'), ('slack_wf_vault_url', 'https://hooks.slack.com/vault');
`);

// ---- helpers ----------------------------------------------------------------
const q = async (sql, params) => (await db.query(sql, params)).rows;
const as = (uid) => db.query(`select set_config('test.uid', $1, false)`, [uid]);
const set = (vault, enabled, file, url = null) =>
  db.query(`select pdm.assembly_alert_set($1, $2, $3, $4)`, [vault, enabled, file, url]);
const checkOut = async (file, user) =>
  (await q(`insert into pdm.locks (file_id, user_id) values ($1, $2) returning id`, [file, user]))[0].id;
const release = (lock) => db.query(`update pdm.locks set released_at = now() where id = $1`, [lock]);
const run = () => db.exec(`select notify.dispatch_assembly_alerts();`);
// Skip the debounce/backoff, then run one cron tick.
const tick = async () => {
  await db.exec(`update notify.assembly_outbox set send_after = now() where status in ('pending', 'retrying');`);
  await run();
};
const rows = () => q(`select * from notify.assembly_outbox order by id`);
const posts = () => q(`select url, body from net.posts order by id`);
const reset = () => db.exec(`delete from notify.assembly_outbox; delete from net.posts; delete from net._http_response; delete from pdm.locks;`);
const answer = (requestId, status) => db.query(`insert into net._http_response (id, status_code) values ($1, $2)`, [requestId, status]);
async function refused(fn, code) {
  try { await fn(); return `no error (wanted ${code})`; }
  catch (e) { return e.code === code ? null : `got ${e.code}: ${e.message}`; }
}
const existingBots = async () => JSON.stringify({
  dispatch: await q(`select pg_get_functiondef('notify.dispatch()'::regprocedure) d`),
  outboxColumns: await q(`select column_name from information_schema.columns where table_schema = 'notify' and table_name = 'outbox' order by 1`),
  outboxRows: await q(`select * from notify.outbox order by id`),
  deliveries: await q(`select count(*)::int n from notify.deliveries`),
  job: await q(`select * from cron.job where jobname = 'helios-notify-dispatch'`),
});

const before = await existingBots();
await db.exec(readFileSync(MIGRATION, "utf8"));

// ---- settings RPCs ----------------------------------------------------------
console.log("settings RPCs");
await as(ADA);
let why = await refused(() => set(SDM27, true, ASM27, URL27), "42501");
check("a non-admin cannot save settings", why === null, why);
why = await refused(() => q(`select * from pdm.assembly_alert_get($1)`, [SDM27]), "42501");
check("a non-admin cannot read settings", why === null, why);

await as(ADMIN);
let got = (await q(`select * from pdm.assembly_alert_get($1)`, [SDM27]))[0];
check("an unconfigured vault reads as off", got.enabled === false && got.file_id === null && got.has_webhook === false);
why = await refused(() => set(SDM27, true, ASM27), "22023");
check("cannot enable without a webhook", why === null, why);
why = await refused(() => set(SDM27, true, null, URL27), "22023");
check("cannot enable without a file", why === null, why);
why = await refused(() => set(SDM27, false, ASM26, URL27), "22023");
check("cannot pick another car's file", why === null, why);
why = await refused(() => set(SDM27, false, GONE27, URL27), "22023");
check("cannot pick a deleted file", why === null, why);
for (const bad of ["http://hooks.slack.com/x", "https://evil.example/x", "https://hooks.slack.com.evil.example/x", "https://hooks.slack.com/x?y=1"]) {
  why = await refused(() => set(SDM27, false, ASM27, bad), "22023");
  check(`rejects webhook ${bad}`, why === null, why);
}
check("failed saves stored nothing", (await q(`select 1 from notify.assembly_alerts`)).length === 0
  && (await q(`select 1 from vault.secrets where name like 'slack_assembly_url_%'`)).length === 0);

await set(SDM27, true, ASM27, URL27);
await set(SDM26, true, ASM26, URL26);
got = (await q(`select * from pdm.assembly_alert_get($1)`, [SDM27]))[0];
check("saved settings read back", got.enabled === true && got.file_id === ASM27
  && got.file_name === "SDM27-Master-Assembly.SLDASM" && got.has_webhook === true);
check("the read never exposes the URL", !JSON.stringify(got).includes("hooks.slack.com"));
await set(SDM27, true, ASM27, "  ");
check("a blank webhook keeps the saved one",
  (await q(`select secret from vault.secrets where name = $1`, [`slack_assembly_url_${SDM27}`]))[0].secret === URL27);
await set(SDM27, true, ASM27, URL27 + "x");
await set(SDM27, true, ASM27, URL27);
check("replacing a webhook keeps one secret per vault",
  (await q(`select 1 from vault.secrets where name = $1`, [`slack_assembly_url_${SDM27}`])).length === 1);

const grants = await q(`select has_function_privilege('anon', 'pdm.assembly_alert_set(uuid,boolean,uuid,text)', 'execute') anon_set,
                               has_function_privilege('anon', 'pdm.assembly_alert_get(uuid)', 'execute') anon_get,
                               has_function_privilege('authenticated', 'pdm.assembly_alert_set(uuid,boolean,uuid,text)', 'execute') auth_set`);
check("RPCs are authenticated-only", !grants[0].anon_set && !grants[0].anon_get && grants[0].auth_set);

// ---- check-out -> Slack -----------------------------------------------------
console.log("check-out to Slack");
await as(ADA);
await reset();
const held = await checkOut(ASM27, ADA);
let queued = await rows();
check("checking out the assembly queues one message", queued.length === 1);
check("the message is the requested wording", queued[0]?.summary === "Ada Lovelace is ON the assembly!", queued[0]?.summary);
await run();
check("nothing is sent during the debounce", (await posts()).length === 0);
await tick();
let sent = await posts();
check("it posts to this car's webhook", sent.length === 1 && sent[0].url === URL27, JSON.stringify(sent));
check("the payload is exactly {text}", JSON.stringify(sent[0]?.body) === JSON.stringify({ text: "Ada Lovelace is ON the assembly!" }), JSON.stringify(sent[0]?.body));

await reset();
await checkOut(PART27, ADA);
check("other files in the vault stay quiet", (await rows()).length === 0);

await reset();
await checkOut(ASM26, NOAH);
await tick();
sent = await posts();
check("each car routes to its own webhook", sent.length === 1 && sent[0].url === URL26);
check("no display name falls back to email", sent[0]?.body.text === "noah@asu.edu is ON the assembly!", sent[0]?.body.text);

await reset();
const misclick = await checkOut(ASM27, ADA);
await release(misclick);
await tick();
check("a check-out undone before the send is not announced", (await posts()).length === 0);
check("the undone row is retired", (await rows())[0]?.status === "skipped");

await reset();
const firstLock = await checkOut(ASM27, ADA);
await release(firstLock);
await checkOut(ASM27, ADA);
queued = await rows();
await tick();
check("undo then re-check-out sends once for the live lock", queued.length === 1 && (await posts()).length === 1);

await reset();
await as(ADMIN);
await set(SDM27, false, ASM27);
await as(ADA);
await checkOut(ASM27, ADA);
check("a disabled car stays quiet", (await rows()).length === 0);
await as(ADMIN);
await set(SDM27, true, ASM27);
await as(ADA);

// ---- delivery ---------------------------------------------------------------
console.log("delivery");
await reset();
await checkOut(ASM27, ADA);
await tick();
let row = (await rows())[0];
check("a sent row goes inflight", row.status === "inflight" && row.attempts === 1);
await answer(row.request_id, 200);
await run();
check("a 2xx marks it sent", (await rows())[0].status === "sent");

await reset();
await checkOut(ASM27, ADA);
await tick();
row = (await rows())[0];
await answer(row.request_id, 400);
await run();
row = (await rows())[0];
check("a Slack 400 is recorded for retry", row.status === "retrying" && row.http_status === 400 && row.last_error === "http 400");
await tick();
check("the retry posts again", (await posts()).length === 2 && (await rows())[0].attempts === 2);

await db.exec(`update notify.assembly_outbox set attempts = 5`);
row = (await rows())[0];
await answer(row.request_id, 400);
await run();
check("it gives up after the retry limit", (await rows())[0].status === "dead");

await reset();
await checkOut(ASM27, ADA);
await tick();
await db.exec(`update notify.assembly_outbox set next_attempt_at = now() - interval '1 minute'`);
await run();
// The stale pass makes it due now, so the same run has already re-posted it.
check("no answer from Slack is retried", (await rows())[0].attempts === 2 && (await posts()).length === 2);

await reset();
const retried = await checkOut(ASM27, ADA);
await tick();
row = (await rows())[0];
await answer(row.request_id, 400);
await run();
await release(retried);
await tick();
check("a retry is dropped once the lock is released", (await rows())[0].status === "skipped" && (await posts()).length === 1);

// ---- failure containment ----------------------------------------------------
console.log("failure containment");
await reset();
await db.exec(`alter table notify.assembly_outbox rename to assembly_outbox_broken;`);
let lockErr = null;
try { await checkOut(ASM27, ADA); } catch (e) { lockErr = e; }
await db.exec(`alter table notify.assembly_outbox_broken rename to assembly_outbox;`);
check("a broken bot never blocks a check-out", lockErr === null, lockErr?.message);

await reset();
await checkOut(ASM27, ADA);
await db.exec(`update vault.secrets set name = 'parked' where name = 'slack_assembly_url_${SDM27}';`);
await tick();
await db.exec(`update vault.secrets set name = 'slack_assembly_url_${SDM27}' where name = 'parked';`);
check("a missing webhook kills the row", (await rows())[0]?.status === "dead");

// The 2026-07 wedge: a failed send returning while a newer row for the same file
// and user is pending must not hit the unique index and abort the whole run.
await reset();
const old1 = await checkOut(ASM27, ADA);
await tick();
const inflight1 = (await rows())[0];
await release(old1);
await checkOut(ASM27, ADA);
await db.exec(`update notify.assembly_outbox set send_after = now() + interval '1 hour' where status = 'pending'`);
await answer(inflight1.request_id, 500);
let wedged = null;
try { await run(); } catch (e) { wedged = e; }
check("a failed send cannot collide with a newer pending row", wedged === null, wedged?.message);
const after = await rows();
check("both rows survive the collision case", after.length === 2 && after[0].status === "retrying" && after[1].status === "pending",
  JSON.stringify(after.map((r) => r.status)));

// Two failures for the same file and user landing in one tick.
await reset();
const l1 = await checkOut(ASM27, ADA);
await tick();
await release(l1);
await checkOut(ASM27, ADA);
await tick();
const both = await rows();
await answer(both[0].request_id, 500);
await answer(both[1].request_id, 500);
wedged = null;
try { await run(); } catch (e) { wedged = e; }
check("two simultaneous failures cannot abort a run", wedged === null, wedged?.message);

// ---- existing bots ----------------------------------------------------------
console.log("existing bots");
await reset();
await checkOut(ASM27, ADA);
await tick();
check("the PM + Vault bots' sender, queue and cron job are unchanged", (await existingBots()) === before);
check("this bot has its own cron job",
  (await q(`select command from cron.job where jobname = 'helios-assembly-alert-dispatch'`))[0]?.command === "select notify.dispatch_assembly_alerts();");
check("existing bots' webhooks are never used", (await posts()).every((p) => p.url === URL27));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
