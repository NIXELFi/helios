-- Record who created a task so the "you can edit tasks you created" branch of
-- pm.can_edit_task actually works.
--
-- pm.tasks.created_by has existed (and is referenced by can_edit_task), but
-- nothing ever populated it: the client never sends it and there was no default,
-- so every row had created_by = NULL and the "creator can edit" path was dead.
-- An engineer who created a task but wasn't its owner could not edit the task
-- they just made — and the failed UPDATE was silently swallowed by RLS, so it
-- looked saved and reverted on reload (in-app report 1548ec9e).
--
-- Setting `default auth.uid()` makes new tasks stamp their creator server-side
-- (the client still never writes the column, so it can't be spoofed). Existing
-- rows keep their NULL created_by — there's no reliable way to recover the
-- original author — so historical tasks remain owner/lead/admin editable only.
--
-- APPLY via the Management API / MCP `apply_migration` (NOT `supabase db push`);
-- this committed file is the mirror. Idempotent.

alter table pm.tasks alter column created_by set default auth.uid();
