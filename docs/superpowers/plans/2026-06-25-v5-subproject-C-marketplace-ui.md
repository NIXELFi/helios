# Sub-project C — Marketplace UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. **Depends on Sub-project B's RPCs + `review_status` model** (the approved-only gating lives in B). Browse stays empty until **D** moves a version to `approved`, so verify end-to-end only after D's transition RPC exists.

**Goal:** Turn the MVP launcher into a real Marketplace: browse available add-ons (scoped by subteam), install / update / uninstall per member, and show an explicit consent screen before installing a plugin that requests high-trust (Tier 2) capabilities.

**Architecture:** Replace the MVP's static-list `MarketplaceModule` with backend-driven views (Browse / Installed / Detail) reading B's hooks, plus an `InstallConsentModal`. The existing fullscreen `PluginHost` launch flow from A is reused unchanged.

**Tech Stack:** React + the `@helios/plugin-sdk` `CAPABILITIES` catalog (for the consent copy + tier coloring), B's `useMarketplace` hooks, Tailwind `helios-*` tokens.

---

## Open decisions (resolve first)

1. **Auto-update vs manual:** show an "update available" badge and let the user click (recommended), vs auto-update on launch. (Roadmap #6.)
2. **Discovery scope in the UI:** show only the member's subteam add-ons by default with an "all subteams" toggle, vs everything. Recommend subteam-first.
3. **Visual design pass:** consider the brainstorming visual companion for the Browse/Detail layout before building (this is the one genuinely visual sub-project).

---

## File structure

| File | Responsibility |
|---|---|
| `apps/desktop/src/modules/marketplace/MarketplaceModule.tsx` (modify) | Top-level: tabs (Browse / Installed), routes to detail + launch. Strip the static `LOCAL_PLUGINS` flow. |
| `apps/desktop/src/modules/marketplace/views/BrowseView.tsx` | Grid of available plugins (cards), subteam filter, search, install button. |
| `apps/desktop/src/modules/marketplace/views/InstalledView.tsx` | Installed list with launch / update / uninstall. |
| `apps/desktop/src/modules/marketplace/views/PluginDetail.tsx` | One plugin: description, permission breakdown, version history, launch/install. |
| `apps/desktop/src/modules/marketplace/components/InstallConsentModal.tsx` | Consent screen listing requested permissions (esp. Tier 2) before install. |
| `apps/desktop/src/modules/marketplace/components/PermissionList.tsx` | Reusable tier-colored permission rows (extract from the MVP `PermissionBadges`). |
| `apps/desktop/src/modules/marketplace/__tests__/*.test.tsx` | Component tests. |

---

## Tasks

### Task C.1 — Extract `PermissionList` from the MVP badges
**Files:** Create `components/PermissionList.tsx`; modify `MarketplaceModule.tsx`.
- [ ] **Step 1:** Write a test asserting a `["engine:matlab"]` plugin renders the Tier-2 (danger) styling + the `CAPABILITIES["engine:matlab"].description` consent text, and `[]` renders "Sandboxed".
- [ ] **Step 2:** Run it (fails — component absent).
- [ ] **Step 3:** Move the `PermissionBadges` logic into `PermissionList` with a `mode: "badge" | "detail"` prop (detail shows the full description per the catalog).
- [ ] **Step 4:** Test passes. Commit: `refactor(marketplace): reusable PermissionList`.

### Task C.2 — Browse view backed by B
**Files:** Create `views/BrowseView.tsx`; tests.
- [ ] **Step 1:** Test: given `useAvailablePlugins` returns two plugins (one installed, one not), the grid renders both, the installed one shows "Open", the other "Install".
- [ ] **Step 2:** Implement BrowseView consuming `useAvailablePlugins`; subteam filter + text search; card → PluginDetail.
- [ ] **Step 3:** Tests green. Commit: `feat(marketplace): browse view`.

### Task C.3 — Install consent + install flow
**Files:** Create `components/InstallConsentModal.tsx`; wire into Browse/Detail.
- [ ] **Step 1:** Test: clicking Install on a plugin requesting `engine:matlab` opens the consent modal with the high-trust warning; confirming calls `useInstall`; cancelling does not.
- [ ] **Step 2:** Implement the modal (renders `PermissionList` in detail mode; an extra red banner when any Tier-2 permission is present, e.g. "This add-on can run MATLAB programs on your computer"). Confirm → `useInstall` (which calls B's `install_plugin` RPC + the `install_plugin_bundle` Tauri command).
- [ ] **Step 3:** Tests green. Commit: `feat(marketplace): install-time consent + install flow`.

### Task C.4 — Installed view: launch / update / uninstall
**Files:** Create `views/InstalledView.tsx`; modify `MarketplaceModule.tsx`.
- [ ] **Step 1:** Test: an installed plugin with a newer approved version shows an "Update" affordance; uninstall calls `useUninstall`; launch mounts `PluginHost`.
- [ ] **Step 2:** Implement; version compare uses the SDK semver helpers. Reuse the A `PluginStage`/`PluginHost` for launch.
- [ ] **Step 3:** Tests green. Commit: `feat(marketplace): installed view with update/uninstall`.

### Task C.5 — Plugin detail + version history
**Files:** Create `views/PluginDetail.tsx`.
- [ ] **Step 1:** Test: detail shows name/subteam/description, the full `PermissionList`, and the approved version list.
- [ ] **Step 2:** Implement; install/launch buttons reuse C.3/C.4 flows.
- [ ] **Step 3:** Tests green + `pnpm --filter @helios/desktop typecheck`. Commit: `feat(marketplace): plugin detail view`.

### Task C.6 — Wire tabs + remove static registry usage
**Files:** Modify `MarketplaceModule.tsx`.
- [ ] **Step 1:** Replace the MVP body with Browse/Installed tabs + detail routing; delete the `LOCAL_PLUGINS` import path (kept only as a dev fallback per B Task 4.2).
- [ ] **Step 2:** Full desktop suite green. Commit: `feat(marketplace): backend-driven marketplace UI`.

## Testing
Component tests with mocked `useMarketplace` hooks (mirror `modules/pm` component tests). The consent-modal Tier-2 path is the security-relevant test — assert it cannot be bypassed for a Tier-2 plugin.

**Release gate:** add a `## [Unreleased]` "Added: browse/install Marketplace UI" bullet to `CHANGELOG.md` (`scripts/check-versions.mjs` fails the release without it).

## Done when
A member browses subteam add-ons, installs one (with consent for any high-trust permission), sees update prompts, launches and uninstalls — all against B's backend.
