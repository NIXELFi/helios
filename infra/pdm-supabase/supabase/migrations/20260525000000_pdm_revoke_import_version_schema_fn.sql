-- Defense-in-depth fix following the 2026-05-25 audit.
--
-- 20260524000000_pdm_import_version_rpc.sql created both pdm.import_version
-- (the schema-resident function) and public.pdm_import_version (the proxy),
-- and correctly REVOKEd EXECUTE on the public proxy from public/anon/
-- authenticated, granting only to service_role. The pdm.import_version
-- function itself was left with the Postgres default (EXECUTE TO PUBLIC).
--
-- The Helios desktop supabase-js client is constructed with
--   db: { schema: 'pdm' }
-- (see packages/auth/src/client.ts), so an authenticated user calling
--   client.rpc("import_version", ...)
-- resolves to pdm.import_version, NOT public.pdm_import_version. The in-body
-- `request.jwt.claims->>'role' <> 'service_role'` check still rejects the
-- call, so this is not actively exploitable. But every other pdm-schema
-- SECURITY DEFINER function got an explicit REVOKE in the 20260511000600
-- hardening pass; this one slipped through. Closing the gap so the in-body
-- role check is belt-and-suspenders rather than the sole barrier.
--
-- The public proxy itself is SECURITY DEFINER and runs with its owner's
-- privileges, so it can still call pdm.import_version regardless of this
-- revoke — no impact on the legitimate service_role flow.

revoke execute on function pdm.import_version(
  uuid, uuid, text, text, bigint, text, timestamptz, jsonb
) from public, anon, authenticated;
