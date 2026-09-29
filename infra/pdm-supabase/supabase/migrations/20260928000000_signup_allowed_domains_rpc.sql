-- Sign-up domain allowlist, readable before auth.
--
-- BUG (onboarding 2026-09-26): five sign-up attempts with non-asu.edu emails
-- were correctly rejected by pdm.enforce_signup_domain(), but GoTrue wraps any
-- trigger exception as HTTP 500 "Database error saving new user", so the form
-- showed a generic failure instead of "use your @asu.edu address".
--
-- FIX: expose the allowlist (domains only) to anon so the sign-up form can check
-- the address inline before any round-trip. The list stays data-driven in
-- pdm.signup_allowed_domains; the trigger remains the real gate.

create or replace function public.list_signup_domains()
returns table(domain text)
language sql
stable
security definer
set search_path = pdm, public
as $$
  select lower(d.domain) from pdm.signup_allowed_domains d order by 1;
$$;

-- Anon must call this from the sign-up form (pre-auth); authenticated too.
revoke all on function public.list_signup_domains() from public;
grant execute on function public.list_signup_domains() to anon, authenticated;
