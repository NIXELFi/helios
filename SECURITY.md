# Security Policy

Helios Vault stores a race team's CAD intellectual property, so we take
authorization and data-safety bugs seriously.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Instead, use
GitHub's private vulnerability reporting on this repository
(Security tab → "Report a vulnerability"), or email the maintainer listed in
the repository profile.

You can expect an acknowledgment within a few days. Please include steps to
reproduce and, for Vault issues, which role (viewer/editor/admin/owner, global
or per-vault) the attacker is assumed to hold.

## Scope

Especially interested in:

- Cross-vault data exposure (RLS bypasses, storage policy gaps, definer-RPC
  authorization mistakes) in `infra/pdm-supabase/`
- Anything that can destroy or overwrite a user's local working copy without
  consent (sync daemon, reaper, bridge server in `apps/desktop/`)
- The localhost bridge (`apps/desktop/src-tauri/src/bridge/`) — auth-token or
  origin-check bypasses
