# Helios Launcher / Auto-Update — Design Spec

**Date:** 2026-05-05
**Owner:** Sun Devil Motorsports (ASU FSAE)
**Status:** Draft for review

## Summary

Ship Helios as a native desktop installer for macOS and Windows, with built-in auto-update so the team always runs the latest version without re-downloading by hand. No separate "launcher" process — Helios is its own launcher: the same binary that runs the dashboard also fetches its own update manifest, verifies it, and relaunches into the new version.

Distribution channel is GitHub Releases on the public `NIXELFi/helios` repo. Builds are produced by GitHub Actions on every `v*` tag push and signed with a Tauri ed25519 keypair. **OS-level code signing (Apple Developer ID, Windows Authenticode) is explicitly deferred** until the team has those accounts; first-install will show the standard "unidentified developer" prompts and the README documents the right-click → Open workaround. Once installed, Tauri-signature-verified auto-updates skip these warnings entirely.

This design is **scoped to macOS + Windows** with first-class auto-update on both. Linux AppImage is built as a CI artifact for completeness but not wired into the in-app updater.

## Goals

- Anyone on the team can install Helios by downloading one file and double-clicking — no Node, Rust, pnpm, cloning, or terminal required.
- After install, Helios checks for updates on launch and presents a clear "install and restart" UX when a new version exists.
- Releasing a new version is `node scripts/bump-version.mjs 2.3.0 && git commit && git tag v2.3.0 && git push --tags` — no manual artifact handling.
- Signature verification on every update so a compromised CDN or man-in-the-middle can't ship a malicious binary.

## Non-Goals (this phase)

- OS-level code signing (Apple Developer ID, Windows Authenticode).
- Beta / nightly channels.
- Self-hosted update server.
- Delta / partial updates.
- In-app crash reporting / telemetry.
- Linux in-app updater. (Linux AppImage is built and uploaded; updating is "redownload manually".)

## Tech additions

- `tauri-plugin-updater@2` (Rust crate)
- `@tauri-apps/plugin-updater` (TypeScript wrapper)
- `tauri-apps/tauri-action@v0` (GitHub Actions step)
- New ed25519 keypair via `@tauri-apps/cli signer generate`

---

## Architecture

```
                 ┌──────────────────────────────┐
                 │  GitHub Releases             │
                 │  NIXELFi/helios              │
                 │  ──────────────────────────  │
                 │  v2.3.0/                     │
                 │    Helios_2.3.0_universal.dmg│
                 │    Helios_2.3.0_x64-setup.exe│
                 │    Helios_2.3.0_aarch64.app.tar.gz │
                 │    Helios_2.3.0_x64.app.tar.gz     │
                 │    Helios_2.3.0_x64-setup.nsis.zip │
                 │    latest.json (signed)      │
                 └──────────┬───────────────────┘
                            │
                  fetch (every launch)
                            │
                            ▼
            ┌────────────────────────────────────┐
            │  Helios.app / Helios.exe           │
            │  ────────────────────────────────  │
            │  • tauri-plugin-updater            │
            │  • verifies ed25519 signature      │
            │  • prompts via Update modal        │
            │  • downloads + replaces + relaunch │
            └────────────────────────────────────┘
```

`/releases/latest/download/latest.json` is a stable URL — GitHub redirects `.../latest/...` to whatever release is most recent, so the app's manifest endpoint never needs to change.

---

## Distribution (Section 1)

### Sole channel: GitHub Releases

- Repo is public, so installer downloads need no auth.
- The same release carries OS installers (`.dmg`, `.exe`, `.msi`) and per-arch update artifacts (`.app.tar.gz`, `.nsis.zip`).
- `latest.json` lives in the same release and is the manifest the auto-updater reads.

### `latest.json` schema

```json
{
  "version": "2.3.0",
  "notes": "Markdown release notes pulled from the GitHub release body",
  "pub_date": "2026-05-05T00:00:00Z",
  "platforms": {
    "darwin-aarch64":  { "signature": "<base64>", "url": "https://github.com/NIXELFi/helios/releases/download/v2.3.0/Helios_2.3.0_aarch64.app.tar.gz" },
    "darwin-x86_64":   { "signature": "<base64>", "url": "https://github.com/NIXELFi/helios/releases/download/v2.3.0/Helios_2.3.0_x64.app.tar.gz" },
    "windows-x86_64":  { "signature": "<base64>", "url": "https://github.com/NIXELFi/helios/releases/download/v2.3.0/Helios_2.3.0_x64-setup.nsis.zip" }
  }
}
```

### Two signature systems, kept separate

| System | Purpose | Cost | Status |
|---|---|---|---|
| **Tauri ed25519** | Verifies the manifest + downloaded artifact inside the running app. Stops a compromised CDN from shipping malware. | Free, generate once. | **In scope this round.** |
| **OS code signing** | Suppresses "unidentified developer" warnings on first install. | $99/yr Apple, ~$200/yr Windows CA. | **Deferred.** First-install shows standard warnings; right-click → Open / Run anyway documented. |

If the repo flips private, anonymous installer downloads break. Auto-update still works (it follows GitHub redirects), but the team would need to either re-publicize, switch to a self-hosted manifest, or have everyone authenticate to GitHub once. Out-of-scope until it happens.

### Linux

Tauri's bundler will build a `.AppImage` in CI as a third matrix runner, uploaded to the same release for completeness. The **in-app updater is not wired for Linux** — Linux installs would update by manual redownload until somebody asks for more. AppImage's update-via-AppImageUpdate path works but isn't worth the lift for a team that's mac-and-windows-only today.

---

## Build & sign pipeline (Section 2)

### Tauri ed25519 keypair (one-time)

```bash
npx @tauri-apps/cli signer generate -w ~/.tauri/helios.key
```

Outputs `helios.key` (private) and `helios.key.pub` (public, base64).

- **Private key** → GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY`. Optional passphrase secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Never enters the repo, never appears in logs.
- **Public key** → committed to `apps/desktop/src-tauri/tauri.conf.json` under `plugins.updater.pubkey`. Embedded in every shipped binary.

If the private key leaks: rotate (generate new keypair, update the secret + the embedded pubkey, ship a new release). Older clients won't be able to verify signatures from the new key, so they'd need a manual reinstall — same path as the very first install.

### Per-platform build artifacts

| Platform | First-install artifact | Auto-updater artifact |
|---|---|---|
| macOS Apple Silicon | `Helios_<v>_aarch64.dmg` | `Helios_<v>_aarch64.app.tar.gz` |
| macOS Intel | `Helios_<v>_x64.dmg` | `Helios_<v>_x64.app.tar.gz` |
| Windows | `Helios_<v>_x64-setup.exe` (NSIS) and `Helios_<v>_x64_en-US.msi` | `Helios_<v>_x64-setup.nsis.zip` |
| Linux (no auto-update) | `Helios_<v>_amd64.AppImage` | — |

Tauri's bundler produces both columns natively. The `.app.tar.gz` and `.nsis.zip` are smaller delta-style uploads that the auto-updater downloads — they only need to replace the binary, not run a full installer.

### App-side wiring

Add to `apps/desktop/src-tauri/Cargo.toml`:
```toml
tauri-plugin-updater = "2"
```

Register in `apps/desktop/src-tauri/src/lib.rs`:
```rust
.plugin(tauri_plugin_updater::Builder::new().build())
```

Add to `apps/desktop/src-tauri/tauri.conf.json`:
```json
"plugins": {
  "updater": {
    "active": true,
    "endpoints": [
      "https://github.com/NIXELFi/helios/releases/latest/download/latest.json"
    ],
    "pubkey": "<base64 from helios.key.pub>"
  }
}
```

Capability file (`apps/desktop/src-tauri/capabilities/default.json`) gains:
```json
"updater:default"
```

Frontend dependency:
```json
"@tauri-apps/plugin-updater": "^2.0.0"
```

### Version management

Today the version drifts across four files:
- `package.json` (root)
- `apps/desktop/package.json`
- `apps/desktop/src-tauri/Cargo.toml` (workspace + crate)
- `apps/desktop/src-tauri/tauri.conf.json`

New script `scripts/bump-version.mjs <version>` rewrites all four to the same value. CI runs a sanity check that all four match before kicking off the build. Releasing is:

```bash
node scripts/bump-version.mjs 2.3.0
git commit -am "chore: bump to 2.3.0"
git tag v2.3.0
git push origin main --tags
```

The tag push triggers CI; CI does the rest.

---

## CI workflow (Section 3)

`.github/workflows/release.yml`

**Trigger:** push of any tag matching `v*`. `workflow_dispatch` enabled for dry runs.

**Jobs:**

### `build` (matrix)

| Runner | Targets |
|---|---|
| `macos-14` | `aarch64-apple-darwin` + `x86_64-apple-darwin` (both via Tauri's universal target) |
| `windows-latest` | `x86_64-pc-windows-msvc` |
| `ubuntu-22.04` | `x86_64-unknown-linux-gnu` (AppImage) |

Steps per runner:
1. Checkout
2. Install Node 20, pnpm 9, Rust stable
3. Run `node scripts/check-versions.mjs` (fails if version fields disagree with tag)
4. `pnpm install --frozen-lockfile`
5. `pnpm test` and `cargo test` (no green tests, no release)
6. `tauri-apps/tauri-action@v0` with `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` env vars to build, sign, and upload artifacts to a draft release named for the tag
7. Cargo registry + target dir cached across runs to keep build time at 3–5 min steady-state (15 min cold)

### `release` (single, depends on all `build` matrix succeeding)

1. Download artifacts from each runner
2. Generate `latest.json` from per-platform signature files (Tauri's tauri-action emits these automatically)
3. Use `gh release edit --draft=false` to promote the draft to published
4. (Optional, deferred) Slack/Discord webhook with the release URL

---

## In-app updater UX (Section 4)

### Header indicator

A small "Updates" pill always visible in the header, next to the existing `Channels` / `Math` / `Edit` buttons. It cycles through these states; clicking it does the right thing for whichever state it's in.

| State | Pill | Click behavior |
|---|---|---|
| Initial (just launched, check in flight) | `…` (spinner) | (no-op until first check completes) |
| Up to date | Dim: `✓ v2.3.0` | Force a manual recheck; toast the result |
| Update available | Gold: `↑ v2.3.1 ready` | Open the update modal |
| Download in progress | Gold pill morphs into a thin progress bar | Open the update modal showing same progress |
| Check failed (offline / endpoint unreachable) | Dim: `– offline` | Force a manual recheck on click |

### Auto-check on launch

App fetches `latest.json` ~3 seconds after first paint, so the splash screen isn't blocked on a network call. The pill enters one of the post-check states above. Failure is silent in the sense that no modal appears, but the pill itself surfaces the state so the user can tell whether the app is up to date vs. couldn't check.

### Manual check

Click the pill in any non-modal state. Toast on completion ("You're on the latest version (v2.3.0)" or "Couldn't reach update server").

### Update modal

Triggered by clicking the pill. Contents:
- Header: `Helios v2.3.0 available — you're on v2.2.4`
- Body: release notes from the GitHub release body, rendered as markdown
- Buttons: **Install and restart** (primary) · **Remind me later** (secondary)

"Install and restart" calls Tauri's `installAndRelaunch()` — Tauri downloads the platform-appropriate artifact, verifies the ed25519 signature against the embedded pubkey, replaces the binary on disk, and relaunches the process.

### Edge cases

| Case | Behavior |
|---|---|
| User is mid-playback (`playback.playing === true`) | "Install and restart" button is disabled with tooltip: "Pause playback first." |
| Signature verification fails | Modal turns red: "Update package failed signature check; please redownload from the website manually." Link to GH Releases page. Never silently skip. |
| Download interrupted / network drops mid-download | Toast on failure, leave existing app intact, reset pill to "available". Retry on next click. |
| No internet at launch | Pill stays hidden. Manual "Check for updates" still works once connectivity returns. |

### Macro behavior table

| User action | Result |
|---|---|
| First-time install on Mac | Downloads `.dmg`, sees Gatekeeper warning, right-clicks → Open. |
| First-time install on Windows | Downloads `.exe`, sees SmartScreen, "More info → Run anyway". |
| Subsequent updates on either OS | Pill in header → click → install and relaunch. No OS warning, because the running app verifies the Tauri signature itself. |

---

## First-run experience (Section 5)

`docs/INSTALL.md` (new, also linked from README) covers:

- **macOS:**
  - Quick path: right-click `Helios.app` → Open → confirm.
  - Power user: `xattr -d com.apple.quarantine /Applications/Helios.app`.
  - Why it happens: no Apple Developer ID code signing yet — see the spec for details.
- **Windows:**
  - SmartScreen path: "More info → Run anyway".
  - Why: no Authenticode signing cert yet.
- **Linux:** download `.AppImage`, `chmod +x`, double-click. No auto-update — redownload manually.

OS code signing later is a CI-only change once accounts exist:
- macOS: `signingIdentity` in tauri.conf.json + `notarize` step in CI.
- Windows: `signCommand` in tauri.conf.json or a CI signing step using a code-signing certificate.

---

## Testing strategy (Section 5)

### Pre-merge (every PR)

- All existing tests still green: `cargo test`, `pnpm test`, `pnpm typecheck`.
- Unit test for `scripts/bump-version.mjs` (golden input → expected file diffs).
- Unit test for `scripts/check-versions.mjs` (tag matches all four version fields).

### Pre-release smoke (manual, once per minor version)

1. Tag a `v<n.n.n>-rc.1` to fire the workflow against a **draft** release.
2. Download the macOS `.dmg` from the draft on a clean-feeling Mac. Install. Confirm Helios launches and the auto-update check pings the manifest endpoint (visible in Network devtools).
3. Same on Windows.
4. To verify the update flow, point a running app at a manifest claiming a higher version and verify the modal appears, install proceeds, and the app relaunches.
5. Promote draft → published. Delete the `-rc.1` tag.

### Watchdog log

App logs `helios-version=<v>, update-check=ok|fail|unreachable` on every launch. Surfaces in console; not phoned home anywhere. Helps debug "the team isn't getting updates" if it ever comes up.

---

## Rollout

1. Land everything from this spec on `main` behind CI (no impact to current users — Helios is dev-only today).
2. Cut `v2.3.0-rc.1`. Smoke-test on Mac and Windows.
3. Cut `v2.3.0` proper. Email/Slack the team with the GH Releases link plus the right-click-Open instructions.
4. From there, every `v*` tag is an auto-update for everyone running Helios. Manual reinstall only when a teammate wipes their machine.

---

## Failure modes / open questions

- **Lost private key** → can't ship updates that existing installs will accept. Recovery is "rotate the keypair, ship a new install, ask everyone to redownload manually." Mitigation: keep the key in a password manager + a backup paper printout in a known location.
- **GitHub Actions outage on release day** → can't cut a release until they recover. Acceptable; that's an outage, not a design problem.
- **GitHub Releases API rate limits** for unauthenticated users hitting `latest.json` → 60 req/hour per IP. Each Helios install hits once per launch. Hard to imagine the team exceeding 60 launches/hour from one office IP, but if it ever happens we can switch to fetching via the GitHub raw URL (different limit) or move to self-hosted (Approach 2 from brainstorm).
- **Linux auto-update** is genuinely deferred — when somebody on the team uses Linux full-time and asks for it, we revisit.
