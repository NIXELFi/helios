-- PM Slack notifications: unwedge the dispatcher + org-model lead resolution.
--
-- Reported 2026-07-14 ("Slack notifications are broken, probably the lead
-- tag"). Diagnosis from prod (cron.job_run_details + notify.outbox):
--
--   1. THE ACTUAL OUTAGE — a coalesce-key wedge. On 2026-06-30 ~16:20 the PM
--      Slack Workflow started returning HTTP 400 (all three failing rows had
--      lead_email NULL → the Workflow's person-by-email lookup can't resolve
--      an empty lead). Two rows burned 5 retries and died; one row was mid-
--      retry (status 'inflight') when its task was edited AGAIN, enqueueing a
--      fresh 'pending' row with the SAME coalesce_key. notify.dispatch()'s
--      recovery UPDATE then tried to flip the inflight row back to 'pending'
--      → unique violation on notify_outbox_coalesce_pending → the WHOLE
--      dispatch transaction aborts. Every 30-second cron run since 06-30
--      16:50 failed the same way; 48 notifications piled up untouched.
--
--   2. THE LEAD TAG — notify.lead_email() only reads the legacy
--      pm.subteam_memberships table (10 stale rows), not the Org & Access
--      model (pm.role_memberships), so leads granted through the org tool
--      (e.g. lead@Chassis, 2026-06-30) never resolve, and subteams without a
--      legacy row send lead:'' — the 400 trigger from (1).
--
-- Fixes, in order: supersede-instead-of-collide in dispatch()'s recovery
-- paths (the wedge can't recur), org-model lead resolution (legacy table
-- kept as fallback), a guaranteed-resolvable lead in the payload (falls back
-- to slack_fallback_email like owner does — the Workflow can't skip an
-- unresolvable person), and a data cleanup that kills the wedged row and the
-- stale two-week backlog (blasting 48 old edits into Slack is noise).

-- 1. Lead resolution: Org & Access first, legacy subteam_memberships second.
create or replace function notify.lead_email(p_subteam uuid)
 returns text language sql stable security definer set search_path to ''
as $$
  select u.email::text
    from (
      select m.user_id, 0 as pri, m.granted_at as since
        from pm.role_memberships m
        join pm.roles r on r.id = m.role_id
       where m.subteam_id = p_subteam and r.key = 'lead'
      union all
      select sm.user_id, 1 as pri, sm.joined_at as since
        from pm.subteam_memberships sm
       where sm.subteam_id = p_subteam and sm.role = 'lead'
    ) c
    join auth.users u on u.id = c.user_id
   where p_subteam is not null
   order by c.pri, c.since, c.user_id
   limit 1;
$$;

-- 2. Dispatcher: recovery paths mark a returning inflight row 'dead'
--    ("superseded") when a newer pending row already holds its coalesce_key,
--    instead of colliding with the partial unique index and aborting the
--    whole run. The lead payload field now falls back to slack_fallback_email
--    — the Workflow's person-by-email step 400s on an empty string, and one
--    fallback ping on a leadless subteam beats losing the notification.
CREATE OR REPLACE FUNCTION notify.dispatch()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_pm_url text; v_vault_url text; v_fallback text; v_url text; v_target text;
  r record; v_req bigint; v_text text; v_body jsonb;
begin
  update notify.outbox o
     set status = case when resp.status_code between 200 and 299 then 'sent'
                       when o.attempts >= 5 then 'dead'
                       when exists (select 1 from notify.outbox p
                                    where p.coalesce_key = o.coalesce_key
                                      and p.status = 'pending' and p.id <> o.id) then 'dead'
                       else 'pending' end,
         http_status = resp.status_code,
         last_error  = case when resp.status_code between 200 and 299 then null
                            when exists (select 1 from notify.outbox p
                                         where p.coalesce_key = o.coalesce_key
                                           and p.status = 'pending' and p.id <> o.id)
                              then 'superseded by a newer pending notification ('||coalesce(resp.error_msg, 'http '||coalesce(resp.status_code::text,'?'))||')'
                            else coalesce(resp.error_msg, 'http '||coalesce(resp.status_code::text,'?')) end,
         sent_at     = case when resp.status_code between 200 and 299 then now() else o.sent_at end,
         send_after  = case when resp.status_code between 200 and 299 then o.send_after
                            else now() + (interval '30 seconds' * power(2, o.attempts)::int) end
   from net._http_response resp
  where o.status = 'inflight' and o.request_id = resp.id;

  update notify.outbox o
     set status = case when o.attempts >= 5 then 'dead'
                       when exists (select 1 from notify.outbox p
                                    where p.coalesce_key = o.coalesce_key
                                      and p.status = 'pending' and p.id <> o.id) then 'dead'
                       else 'pending' end,
         last_error = case when exists (select 1 from notify.outbox p
                                        where p.coalesce_key = o.coalesce_key
                                          and p.status = 'pending' and p.id <> o.id)
                             then 'superseded by a newer pending notification (no response, stale)'
                           else 'no response (stale)' end,
         send_after = now()
   where o.status = 'inflight' and o.next_attempt_at < now()
     and not exists (select 1 from net._http_response resp where resp.id = o.request_id);

  select decrypted_secret into v_pm_url    from vault.decrypted_secrets where name='slack_wf_activity_url' limit 1;
  select decrypted_secret into v_vault_url from vault.decrypted_secrets where name='slack_wf_vault_url'    limit 1;
  select decrypted_secret into v_fallback  from vault.decrypted_secrets where name='slack_fallback_email'  limit 1;

  for r in
    select * from notify.outbox where status='pending' and send_after<=now()
     order by send_after limit 8 for update skip locked
  loop
    if r.source = 'vault' then v_url:=v_vault_url; v_target:='channel:vault';
    else                       v_url:=v_pm_url;    v_target:='channel:pm'; end if;
    if v_url is null then continue; end if;

    v_text := r.summary || case when r.edit_count > 1 then ' · '||r.edit_count||' edits' else '' end;
    if r.source = 'vault' then
      v_body := jsonb_build_object('text', v_text);
    else
      -- actor/owner/lead are Slack-user EMAILS; the Workflow resolves + mentions
      -- them. All three fall back to slack_fallback_email — the Workflow's
      -- person-by-email lookup rejects the whole payload (http 400) on an
      -- empty/unresolvable value, so every field must carry a real member.
      v_body := jsonb_build_object('text', v_text,
                                   'actor', coalesce(nullif(r.actor_email, ''), v_fallback),
                                   'owner', coalesce(nullif(r.owner_email, ''), v_fallback),
                                   'lead',  coalesce(nullif(r.lead_email, ''),  v_fallback));
    end if;

    begin
      v_req := net.http_post(url := v_url, body := v_body);
      update notify.outbox set status='inflight', request_id=v_req, attempts=attempts+1, last_error=null,
             next_attempt_at = now() + interval '2 minutes' where id = r.id;
      insert into notify.deliveries (outbox_id, event_id, target, status, attempts)
        values (r.id, r.event_id, v_target, 'sent', r.attempts+1);
    exception when others then
      update notify.outbox set status = case when attempts >= 5 then 'dead' else 'pending' end,
             attempts = attempts+1, last_error = SQLERRM, send_after = now() + interval '1 minute' where id = r.id;
      insert into notify.deliveries (outbox_id, event_id, target, status, attempts, last_error)
        values (r.id, r.event_id, v_target, 'error', r.attempts+1, SQLERRM);
    end;
  end loop;
end $function$;

-- 3. Data cleanup: kill the wedged inflight row and retire the backlog that
--    accumulated while the dispatcher was down (>24h old = stale news; fresh
--    rows flow out normally on the next cron tick).
update notify.outbox
   set status = 'dead',
       last_error = 'superseded (dispatcher wedged 2026-06-30 → 2026-07-14, see 20260714020000)'
 where status = 'inflight' and created_at < now() - interval '1 hour';

update notify.outbox
   set status = 'dead',
       last_error = 'stale (dispatcher wedged 2026-06-30 → 2026-07-14, see 20260714020000)'
 where status = 'pending' and created_at < now() - interval '24 hours';
