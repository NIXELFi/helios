-- Restore anon read on pdm.subteams (regression from 20260610100000).
--
-- 20260610100000 tightened subteams_read from {anon, authenticated} to
-- {authenticated} on the reasoning "org structure should require a session."
-- That was wrong: the SIGN-UP form (apps/desktop/src/auth/AuthModal.tsx and
-- the useSubteams hook) reads pdm.subteams while the user is still anonymous
-- — they pick their subteam BEFORE the account exists. Revoking anon read
-- left every new signup with an empty subteam picker and a dead-ended form.
--
-- Subteam names are non-sensitive (they're literally rendered on a public
-- sign-up screen by design), so anon SELECT is the intended contract. This
-- restores it. Writes stay admin-gated (unchanged).
drop policy if exists subteams_read on pdm.subteams;
create policy subteams_read on pdm.subteams
  for select to anon, authenticated
  using (true);
