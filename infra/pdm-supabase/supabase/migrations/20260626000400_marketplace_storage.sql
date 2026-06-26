-- v5.0.0 Marketplace — Sub-project B, Phase 3c: content-addressed bundle storage.
--
-- A private `plugins` bucket holds `.hplugin` zips keyed by their sha256 (mirrors
-- the Vault's content-addressed model: immutable + de-duplicated). The publish
-- client uploads the bundle here BEFORE calling publish_plugin_version; install
-- clients mint a short-lived signed URL to download it. Bundle authenticity is
-- enforced downstream (the desktop re-checks sha256 + Ed25519 signature before
-- unpacking), so these policies gate WHO may read/write, not byte integrity.

insert into storage.buckets (id, name, public)
values ('plugins', 'plugins', false)
on conflict (id) do nothing;

-- READ: approved bundles are readable by any authenticated member (so they can
-- mint a signed URL to install); non-approved bundles only by the owning
-- subteam's publishers + reviewers (so review/D and pre-approval testing work).
-- Object name == the version's sha256.
drop policy if exists "marketplace_plugins_read" on storage.objects;
create policy "marketplace_plugins_read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'plugins'
    and exists (
      select 1 from marketplace.plugin_versions v
      where v.bundle_sha256 = name
        and (
          v.review_status = 'approved'
          or pm.has_capability(auth.uid(), 'marketplace.review',  marketplace.plugin_subteam(v.plugin_id))
          or pm.has_capability(auth.uid(), 'marketplace.publish', marketplace.plugin_subteam(v.plugin_id))
        )
    )
  );

-- WRITE: anyone who can publish in some subteam may upload a content-addressed
-- object (name must be a 64-hex sha256). The DB publish RPC does the real
-- subteam-scoped authorization + binds the bytes to a version row; this is just
-- the upload gate. Objects are immutable: no UPDATE/DELETE policy (default deny).
drop policy if exists "marketplace_plugins_insert" on storage.objects;
create policy "marketplace_plugins_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'plugins'
    and name ~ '^[0-9a-f]{64}$'
    and exists (
      select 1
      from pm.role_memberships m
      join pm.role_capabilities rc on rc.role_id = m.role_id
      where m.user_id = auth.uid()
        and rc.capability_key = 'marketplace.publish'
    )
  );
