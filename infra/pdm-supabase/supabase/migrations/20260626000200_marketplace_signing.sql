-- v5.0.0 Marketplace — Sub-project B, Phase 3a: bundle signing (decision: sign at
-- publish, 2026-06-26).
--
-- Every published version is signed with a marketplace-held Ed25519 key over a
-- deterministic, domain-separated canonical message binding the plugin id,
-- version, content hash, and byte length. The desktop reconstructs the EXACT same
-- message and verifies the detached signature (with the public key fetched via
-- `marketplace.signing_public_key()`) AND re-checks the sha256 of the downloaded
-- bytes before unpacking — so neither a tampered storage object nor an altered
-- transit payload can install.
--
-- Threat-model note (v5.0.0, internal FSAE tool): the private key lives in a
-- locked-down table that no API role can read (RLS on, zero grants) and is used
-- only by SECURITY DEFINER functions. This defeats the realistic threats —
-- storage-object tampering and transit tampering — because the public key is
-- served over authenticated PostgREST while bundles come from Storage; a Storage
-- compromise alone cannot forge a signature. It does NOT defend against a full
-- database compromise (which could read the secret); moving the secret to
-- external custody (Vault/HSM/CI signer) is tracked for v5.1.
--
-- ⚠️ LIVE-VERIFICATION DEPENDENCY: this relies on pgsodium's libsodium wrappers
-- (`crypto_sign_keypair`, `crypto_sign_detached`) being available on the project.
-- That MUST be confirmed against the live DB before relying on publish-time
-- signing; if pgsodium's signing API is unavailable, swap `marketplace.sign_message`
-- for the Deno edge-function signer sketched in the B plan — the canonical message,
-- schema, and desktop verification are signer-independent, so only that one
-- function changes.

create extension if not exists pgsodium;

-- ---------------------------------------------------------------------------
-- 1. Locked-down key store. No grants + RLS-with-no-policy => unreadable via the
--    API; only the SECURITY DEFINER functions below (running as owner) touch it.
-- ---------------------------------------------------------------------------
create table if not exists marketplace.signing_keys (
  id          text primary key,            -- public-key fingerprint (sha256 prefix)
  alg         text not null default 'ed25519',
  public_key  bytea not null,
  secret_key  bytea not null,              -- NEVER exposed via API
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
alter table marketplace.signing_keys enable row level security;
revoke all on marketplace.signing_keys from authenticated, anon;

-- ---------------------------------------------------------------------------
-- 2. Active keypair = SEEDED OUT-OF-BAND per environment.
--    Supabase locks pgsodium's key-GENERATION functions (crypto_sign_keypair /
--    crypto_sign_new_keypair are permission-denied), even though the SIGN op
--    (pgsodium.crypto_sign_detached, used by sign_message below) works. So the
--    active Ed25519 keypair is generated CLIENT-SIDE and inserted into
--    signing_keys out-of-band — the secret is NEVER committed to this repo. See
--    the deploy runbook. (v5.1 hardening: move the secret to external key custody
--    / a CI signer; sign_message is the only thing that reads it.)
--
--    Seed command (run once per environment, secret kept out of source control):
--      insert into marketplace.signing_keys (id, alg, public_key, secret_key, active)
--      values (left('<sha256(pub) hex>',16), 'ed25519', '\x<pub32hex>'::bytea,
--              '\x<secret64hex>'::bytea, true);

-- ---------------------------------------------------------------------------
-- 3. Canonical signing message (pure, signer-independent). The desktop MUST
--    reconstruct this byte-for-byte: domain tag + LF-separated fields, sha256
--    lowercased. Changing this format is a breaking change to every signature.
-- ---------------------------------------------------------------------------
create or replace function marketplace.signing_message(
  p_plugin_id text, p_version text, p_sha256 text, p_bytes bigint
) returns bytea
language sql immutable as $$
  select convert_to(
    'helios-plugin-v1' || E'\n' ||
    p_plugin_id        || E'\n' ||
    p_version          || E'\n' ||
    lower(p_sha256)    || E'\n' ||
    p_bytes::text,
    'UTF8'
  );
$$;

-- ---------------------------------------------------------------------------
-- 4. Sign a message with the active key (SECURITY DEFINER: only this function and
--    the publish RPC ever read the secret). Returns the base64 detached sig, the
--    algorithm, and the key fingerprint to store on the version row.
-- ---------------------------------------------------------------------------
create or replace function marketplace.sign_message(p_msg bytea)
returns table (signature text, sig_alg text, signing_key_id text)
language plpgsql volatile security definer
set search_path = marketplace, pgsodium, public as $$
declare k record;
begin
  select id, secret_key into k
  from marketplace.signing_keys where active
  order by created_at desc limit 1;
  if k.id is null then
    raise exception 'marketplace: no active signing key';
  end if;
  return query select
    -- Strip Postgres's 76-column base64 line-wrap: encode(...,'base64') inserts a
    -- newline every 76 chars, but the desktop verifier (verify.rs) decodes with the
    -- strict STANDARD base64 engine and only trims the ends — an embedded newline in
    -- an 88-char signature would make EVERY signed bundle fail to install. Emit
    -- single-line base64 so the detached signature round-trips.
    replace(encode(pgsodium.crypto_sign_detached(p_msg, k.secret_key), 'base64'), E'\n', ''),
    'ed25519'::text,
    k.id;
end $$;
-- Not granted to API roles: only the publish RPC (also SECURITY DEFINER) calls it.
revoke all on function marketplace.sign_message(bytea) from authenticated, anon;

-- ---------------------------------------------------------------------------
-- 5. Public key for desktop verification (safe to expose; secret stays server-side).
-- ---------------------------------------------------------------------------
create or replace function marketplace.signing_public_key()
returns table (key_id text, public_key text, alg text)
language sql stable security definer
set search_path = marketplace, public as $$
  select id, encode(public_key, 'base64'), alg
  from marketplace.signing_keys where active
  order by created_at desc limit 1;
$$;
grant execute on function marketplace.signing_public_key() to authenticated;
