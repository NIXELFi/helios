-- Backend-enforced sign-up email-domain restriction (H-1).
--
-- Self-sign-up with the public anon key is open, so a SERVER-SIDE gate is the
-- real control (a frontend check is UX-only and bypassable). Only emails whose
-- domain is listed in pdm.signup_allowed_domains may create an account. The
-- domain is intentionally NOT hardcoded in the app — it lives in this table so
-- an admin can add/remove domains without a code change or release.
--
-- Seeded with 'asu.edu'. An EMPTY table disables the gate (allow any). The check
-- is skipped on test databases (app.environment = 'test'), which create
-- arbitrary @helios.test users — mirroring pdm.test_reset()'s environment guard
-- (migration 20260511001200) so the integration suite is unaffected.

create table if not exists pdm.signup_allowed_domains (
  domain   text primary key,
  added_by uuid,
  added_at timestamptz not null default now()
);

insert into pdm.signup_allowed_domains (domain) values ('asu.edu')
  on conflict (domain) do nothing;

-- Config table is touched only by the SECURITY DEFINER trigger below and by the
-- service role / a future admin RPC. No anon/authenticated access.
alter table pdm.signup_allowed_domains enable row level security;
revoke all on pdm.signup_allowed_domains from anon, authenticated;

create or replace function pdm.enforce_signup_domain()
returns trigger language plpgsql security definer set search_path = pdm, public, auth as $$
declare v_domain text;
begin
  -- Test DBs create arbitrary @helios.test users; never gate them.
  if coalesce(current_setting('app.environment', true), '') = 'test' then
    return new;
  end if;
  -- Non-email (e.g. phone) sign-ups are out of scope for a domain gate.
  if new.email is null or new.email = '' then
    return new;
  end if;
  -- Empty allowlist = gate disabled (any well-formed email allowed).
  if not exists (select 1 from pdm.signup_allowed_domains) then
    return new;
  end if;
  v_domain := lower(split_part(new.email, '@', 2));
  if not exists (
    select 1 from pdm.signup_allowed_domains d where lower(d.domain) = v_domain
  ) then
    raise exception 'sign-up is restricted to approved email domains'
      using errcode = '42501', hint = 'Use your organization email address.';
  end if;
  return new;
end; $$;

-- BEFORE INSERT so a disallowed domain is rejected before the row (and before
-- the AFTER-INSERT auto-provision trigger) ever runs.
drop trigger if exists enforce_signup_domain on auth.users;
create trigger enforce_signup_domain
  before insert on auth.users
  for each row execute function pdm.enforce_signup_domain();
