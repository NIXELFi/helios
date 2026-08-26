# Add to Marketplace — self-serve plugin publishing

Status: approved design, 2026-08-26
Branch: `feat/marketplace-add-to-marketplace`

## Why

The v5 marketplace backend has been live in prod since 2026-07-01, but only half
of it is reachable. Members can browse, install, and launch plugins. **Nobody can
publish one from inside Helios.** Every deploy to date has been a hand-rolled
sequence of Management API SQL, a manually built zip, and a direct Storage upload
run by one person.

`MarketplaceModule.tsx:204` is the honest summary of the current state: a disabled
button reading "Upload plugin — Soon".

This spec closes that half. A subteam engineer picks a folder, sees whether it
passes, submits it, and watches it through review — without a terminal, without
SQL, and without waiting on the one person who knows the runbook.

## What already exists (and is NOT re-litigated here)

| Piece | State |
|---|---|
| `marketplace.publish_plugin_version` | Live. Validates the manifest server-side, enforces `marketplace.publish` per subteam, signs Ed25519 at publish time, lands `pending`. |
| `marketplace.review_plugin_version` / `review_queue` | Live. Approve/reject, recomputes `latest_version`, enforces separation of duties. |
| `plugins` Storage bucket | Live. Content-addressed by sha256; the insert policy already admits any holder of `marketplace.publish`. |
| Capabilities | Already seeded and granted: `marketplace.publish` to owner/executive/lead/vp/**engineer**; `marketplace.review` to owner/executive/lead/vp. **No new grants needed.** |
| Verified install | Live. `install_plugin_bundle` verifies sha256 + signature, unpacks, serves over `plugin://`. |
| `scanBundle` / `validateManifest` | Live in `packages/plugin-sdk`. `scanBundle(files, manifest)` is pure JS with no node builtins — importable from the desktop frontend. |
| Authoring kit | Six docs in `docs/plugin-authoring/`. Invisible from inside the app. |

Two constraints inherited from the existing backend shape the UI and must not be
designed around:

1. **Versions are immutable.** `publish_plugin_version` raises on a duplicate
   `(plugin_id, version)`. The UI's job is to turn that into a helpful message,
   not to work around it.
2. **A publisher cannot approve their own submission** (separation of duties, M3,
   `20260626000500_marketplace_review.sql`). A lead publishing into their own
   subteam still needs an independent reviewer. The submit confirmation must
   therefore name who *else* can approve — never imply self-approval.

## Scope

Four surfaces plus onboarding:

1. **Submit wizard** — folder to submitted version, with pre-flight.
2. **My Plugins** — versions, status, withdraw, yank, recommend.
3. **Review** — queue, permission diff, independent re-scan, test-drive, decide.
4. **Agent kit** — project scaffold, copy-paste agent prompt, contextual help.

Out of scope: ownership transfer between subteams (`publish_plugin_version`
deliberately forbids reassignment; reopening it is its own decision), install
counts (installs are RLS-scoped to self and would need a new aggregate RPC), and
the Phase 0.2 iframe self-nav hardening (tracked in
`2026-06-26-plugin-nav-hardening-decision.md`).

## Architecture

```
  author's folder
        |
        v
  [Rust] pack_plugin_bundle  -> .hplugin (forward-slash entries) + sha256 + manifest + file texts
        |
        v
  [TS] pre-flight: validateManifest + scanBundle       <- the same module review runs
        |
        v
  [Storage] PUT plugins/<sha256>                       <- content-addressed, dedup on hash
        |
        v
  [RPC] publish_plugin_version  -> review_status = 'pending'
        |
        v
  [Review tab] inspect_plugin_bundle (re-scan the STORED bytes) + optional test-drive
        |
        v
  [RPC] review_plugin_version 'approved' -> latest_version bumps -> Browse -> install
```

The single most important property: **the pre-flight scan and the review scan are
the same code** (`compliance.mjs`), so the wizard can truthfully tell a non-coder
"green here means green in review." That claim is the entire reason pre-flight
exists; any drift between the two scans destroys it.

### Component boundaries

New code is organized so that no file has to hold two jobs:

```
crates/plugin-host/src/pack.rs                    pure: dir -> zip bytes + sha256; zip -> file texts
apps/desktop/src-tauri/src/plugins/commands.rs    +2 thin Tauri wrappers
apps/desktop/src/modules/marketplace/
  publish/
    usePublish.ts        pack -> preflight -> upload -> RPC, as one state machine
    SubmitWizard.tsx     step chrome only; no business logic
    steps/*.tsx          one file per step
    preflight.ts         pure: (files, manifest) -> grouped, explained findings
    permissionDiff.ts    pure: (prev[], next[]) -> added / removed / unchanged
  manage/
    useMyPlugins.ts      my_published_plugins + withdraw / yank / recommend
    MyPluginsView.tsx
  review/
    useReview.ts         (exists) + inspect / preview additions
    ReviewView.tsx
  authoring/
    scaffold.ts          writes the starter project via @tauri-apps/plugin-fs
    kit.ts               build-time ?raw glob over docs/plugin-authoring/*.md
    agentPrompt.ts       pure: (project) -> copy-paste prompt string
    HelpDrawer.tsx
```

`preflight.ts`, `permissionDiff.ts`, and `agentPrompt.ts` are pure functions with
no React and no IO. They carry the logic worth testing, and they are the reason
the view files stay thin enough to reason about.

## 1. Submit wizard

Entry: the header button, now live, reading **Add to Marketplace**. Visible to
everyone; if the caller holds `marketplace.publish` nowhere, clicking it explains
what the capability is and that a lead or VP grants it, rather than hiding.

### Step 1 — Choose your plugin folder

`@tauri-apps/plugin-dialog` directory picker, then
`pack_plugin_bundle(dir) -> { manifest, sha256, bytes, entries, texts, warnings }`.

Packing rules (in `crates/plugin-host/src/pack.rs`, pure and unit-tested):

- Requires `manifest.json` at the folder root.
- Includes `manifest.json` plus everything under the top-level directory named by
  `manifest.entry` (normally `dist/`), and the `icon` path if it sits elsewhere.
- Excludes `node_modules/`, `.git/`, `src/`, `.DS_Store`, `Thumbs.db`, `*.map`.
- **Every zip entry uses a forward slash**, unconditionally. This is the failure
  that has already cost a release; after this change it is unreachable by
  construction rather than by discipline.
- Refuses symlinks, refuses entries escaping the root, refuses an empty result.
- Enforces the 25 MiB ceiling locally, with a message naming the largest files,
  instead of surfacing a Postgres range exception.
- Deterministic: entries sorted, timestamps zeroed, so the same folder yields the
  same sha256. Re-submitting an unchanged folder is then visibly a no-op.

It returns the decoded text of every scannable file, so the frontend can pre-flight
without a second disk pass.

### Step 2 — Pre-flight

`validateManifest(manifest)` + `scanBundle(texts, manifest)`, rendered in three
groups:

- **Blocking errors** — forbidden APIs (`fetch`, `localStorage`, `eval`,
  `window.parent`), manifest violations, undeclared permissions in use. Submit is
  disabled.
- **Warnings** — declared-but-unused permissions, missing description or icon, no
  `PLUGIN.md`. Submit is allowed.
- **Green checks** — stated positively, because a non-coder needs to see what
  passed, not only what failed.

Every finding carries a one-line plain-English explanation and a link that opens
the Help drawer at the exact rule. `preflight.ts` owns that mapping; the view only
renders it.

### Step 3 — Confirm

New plugin: choose the owning subteam from those where the caller holds publish
(`useSubteams` filtered by `can("marketplace.publish", id)`).

Existing plugin: owner shown locked, plus a **permission diff against the last
approved version** — added permissions in alarm styling, removed ones muted. A
version that requests no new permissions says so plainly; that is the common case
and it should feel routine.

Also shown: id, version, size, file count, and the sha256 that will be signed.

### Step 4 — Submit

1. Upload to `plugins/<sha256>` with `upsert: false`. A duplicate-object error is
   treated as success rather than retried: the key *is* the content hash, so an
   object already there is by definition the same bytes. (The bucket has no UPDATE
   or DELETE policy, so `upsert: true` would fail anyway.)
2. `publish_plugin_version(manifest, sha256, bytes, subteam)`.
3. The confirmation names the reviewers who can act on it, **excluding the
   author**, per separation of duties.

Failure handling is specific, never a raw Postgres string:

| Failure | Response |
|---|---|
| duplicate version | "Version 1.2.0 of this plugin already exists, and versions can never be changed. Bump `version` in manifest.json to 1.2.1 and pack again." |
| no publish capability for the subteam | names the capability and who grants it |
| over 25 MiB | lists the largest files |
| offline / upload failure | keeps the packed bundle, so Retry does not re-zip |
| entry missing from bundle | "manifest.entry points at dist/index.html, which is not in the folder — did you run your build?" |

## 2. My Plugins

Every plugin the caller can publish to. Per plugin: name, id, owning subteam,
`latest_version`, the recommend toggle, and the full version list with status
chips (pending / approved / rejected / withdrawn / yanked). Rejection notes render
inline — a rejection nobody reads is a rejection that repeats.

Actions:

- **Withdraw** a pending submission (`withdrawn`).
- **Yank** an approved version (`yanked`). Existing installs keep working — they
  are already unpacked locally — it simply stops being offered and installable,
  and `latest_version` falls back to the previous approved version. The
  confirmation states exactly that, so nobody yanks expecting a remote kill switch.
- **Recommended for my subteam** toggle (`plugins.is_recommended`).

Listing metadata (description, icon) comes from the manifest, so there is no
separate listing editor to drift out of sync: you fix your listing the same way
you fix anything else, by publishing a version.

## 3. Review

Gated on `marketplace.review`, with the pending count badged on the tab.

Per queued version: manifest, permission diff vs the last approved version,
author, age, and the **compliance report re-run on the stored bytes**. The
author's pre-flight report is author-supplied and trivially bypassable by calling
the RPC directly, so the reviewer's copy is regenerated from what is actually in
Storage: `inspect_plugin_bundle(signed_url) -> { manifest, texts }`, reusing
`unpack_zip` and `sha256_hex` from `plugin-host`, then the same `scanBundle`.
Cheap, because the unzip and hash code already exist, and it is the difference
between a review gate and a rubber stamp.

**Test-drive before approving.** A reviewer may install a pending version locally
and run it. This is a separate RPC, `install_plugin_for_review`, not a relaxation
of `install_plugin` — the approved-only rule there stays absolute. The preview
records itself in `plugin_installs` like any install, so it is auditable, but with
`is_preview = true`: without that flag, `list_available_plugins` would report the
pending version as the reviewer's `installed_version` and Browse would show an
unapproved build as installed. Browse ignores preview rows; the Review UI labels
the running plugin as an unapproved preview, and approving or rejecting clears it.

Decision: approve or reject with notes, through the existing
`review_plugin_version`, passing the reviewer-generated report as `p_report`. The
UI never offers approve on the caller's own submission; it explains why.

## 4. Agent kit

Most authors are non-coders whose AI agent is the actual developer. The kit is
built for that reader.

**Start a new plugin** writes a real project into a chosen folder:

```
my-plugin/
  manifest.json               filled in: id, name, version 0.1.0, permissions []
  PLUGIN.md                   from PLUGIN.template.md
  dist/index.html             working hello-world; awaits ready(), renders, computes
  AUTHORING-KIT/*.md          all six authoring docs, as local files
  START-HERE.md               what this folder is, and what to do next
```

It then offers a **copy-paste agent prompt**: the folder path, the plugin id and
name, the golden rules in brief, and the instruction to read
`AUTHORING-KIT/README.md` before writing a line, keep `PLUGIN.md` current, and
tell its human to click Add to Marketplace once the build is in `dist/`. The agent
reads the contract off disk rather than being told about it secondhand.

The kit docs are embedded at build time via a Vite `?raw` glob over
`docs/plugin-authoring/*.md`. **One copy in the repo**; the scaffold cannot drift
from the shipped SDK.

**Help drawer**, reachable from every wizard step and both new tabs: what a plugin
is, what the sandbox blocks and why, what each permission grants in plain words,
how review works, and what to do after a rejection. Pre-flight findings deep-link
into it.

## Data model changes

One migration, `20260826010000_marketplace_publish_ui.sql` (`20260826000000` is
already taken by the plinko search-path fix):

1. Widen the `review_status` check to
   `('pending','approved','rejected','withdrawn','yanked')`. `list_available_plugins`
   and `install_plugin` already test for `= 'approved'`, and `review_queue` tests
   for `= 'pending'`, so both new states fall out of distribution *and* out of the
   review queue with no change to any of the three.
1b. `alter table marketplace.plugin_installs add column is_preview boolean not null
   default false`, and teach `list_available_plugins` to ignore preview rows when
   reporting `installed_version`.
2. `marketplace.my_published_plugins()` — plugins plus all versions the caller can
   publish to. SECURITY INVOKER; the existing RLS already exposes non-approved rows
   to the owning subteam's publishers.
3. `marketplace.withdraw_plugin_version(plugin_id, version)` — `pending` to
   `withdrawn`. Requires publish on the owning subteam.
4. `marketplace.yank_plugin_version(plugin_id, version, reason)` — `approved` to
   `yanked`, then recomputes `latest_version` exactly as `review_plugin_version`
   does.
5. `marketplace.set_plugin_recommended(plugin_id, value)` — requires publish on the
   owning subteam.
6. `marketplace.install_plugin_for_review(plugin_id, version)` — mirrors
   `install_plugin`, but requires `marketplace.review` on the owning subteam and
   accepts `pending` only.

All are SECURITY DEFINER with an explicit `set search_path`, matching the existing
RPCs, and all re-check capabilities server-side. The UI gating is convenience,
never the boundary.

## Testing

**Rust** (`crates/plugin-host`, runnable locally — the desktop crate's tests
cannot run here: WebView2 0xc0000139, CI only): pack determinism, forward-slash
entries from Windows paths, exclusion rules, the size ceiling, symlink and
traversal refusal, a missing manifest, an entry not present in the bundle, and a
pack-to-`unpack_zip` round trip whose sha256 matches what install verifies.

**TypeScript** (vitest, alongside the existing 47 marketplace tests): the publish
state machine including every failure branch, `preflight.ts` grouping and
explanation mapping, `permissionDiff.ts`, `agentPrompt.ts`, scaffold file
generation, My Plugins actions and their confirmations, Review approve/reject and
the self-approval block, and capability gating — no publish anywhere means no My
Plugins tab.

**SQL** (the existing RLS harness): withdraw / yank / recommend ACLs, a yanked
version disappearing from `list_available_plugins` and being refused by
`install_plugin`, and `install_plugin_for_review` refusing a non-reviewer and
refusing an already-approved version.

**Visual**: screenshot verification of the wizard, both new tabs, and the Help
drawer before any of it is called done, per the standing rule.

## Sequencing

- **Phase 1 — the loop closes**: migration, `pack.rs`, both Tauri commands, submit
  wizard, Review tab. End to end: an engineer publishes, a lead approves, a member
  installs. Nothing before this point is usable on its own.
- **Phase 2 — maintenance**: My Plugins, withdraw, yank, recommend.
- **Phase 3 — onboarding**: scaffold, agent prompt, Help drawer. The drawer's
  content file lands in Phase 1, so pre-flight findings have somewhere to link.

A CHANGELOG `[Unreleased]` entry accompanies each phase, or the release gate fails.
