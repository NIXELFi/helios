-- Pulse "times out the first time, loads the second time".
--
-- pdm.admin_ops_overview() reads the last run of every pg_cron job with a
-- per-job `order by start_time desc limit 1` against cron.job_run_details.
-- That table had never been pruned: 440k rows / 120 MB by 2026-10-20 (91% from
-- helios-notify-dispatch, every 30 s = ~2,900 rows/day), and it has no
-- (jobid, start_time) index -- it is owned by supabase_admin, so we cannot add
-- one. Each lookup was a full scan; on a cold cache the overview hit the 8 s
-- authenticated statement_timeout (500 at ~8.1 s in the edge logs on 10-17 and
-- 10-20), and the retry succeeded once the pages were warm.
--
-- Fix: keep 7 days of run history (what the Pulse cron card needs) and prune
-- nightly so it stays bounded (~20k rows).
--
-- Hosted migration history is drifted: apply via the Management API query
-- endpoint and record the version by hand. Do NOT db push.

delete from cron.job_run_details where start_time < now() - interval '7 days';

select cron.schedule(
  'cron-run-history-prune',
  '40 0 * * *',
  $$delete from cron.job_run_details where start_time < now() - interval '7 days'$$
);
