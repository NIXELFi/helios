# Bundled binaries — READ BEFORE EDITING

These prebuilt binaries are **committed on purpose** and shipped verbatim inside
the installer. **CI does not build them.**

| File | Source project | Built by |
|------|----------------|----------|
| `addin/HeliosVault.dll` | `solidworks-addin/src` | `pnpm -C apps/desktop build:addin` |
| `shell/HeliosShell.dll` | `shell-ext/src` | `pnpm -C apps/desktop build:shell` |
| `shell/SharpShell.dll` | (vendored 3rd-party dep of the shell ext) | copied by `build:shell` |
| `swhelper/HeliosSwReadonly.exe` | `sw-helper/src` | `pnpm -C apps/desktop build:swhelper` |

## Why this matters

The release build runs `tauri build` (via `tauri-action`), which **bundles**
these files into the installer (`.exe`/`.dmg`/`.AppImage`) and extracts them to
the install dir at install time. It **never** runs `dotnet build` — the GitHub
runner has no SOLIDWORKS and the C# build scripts (`build:addin` / `build:shell`
/ `build:swhelper`, only chained into `build:win`) are not invoked in CI.

**Consequence:** if you change C# source and forget to rebuild + commit the DLL
here, a **stale** binary ships silently — the app/installer build still
succeeds.

## The rule

After ANY change under `solidworks-addin/`, `shell-ext/`, or `sw-helper/`,
**before tagging a release**, rebuild and commit the updated binary:

```sh
# rebuild all three C# projects and copy outputs into resources/
pnpm -C apps/desktop build:win        # (addin + shell + swhelper + tauri build)
# or just the one you changed, e.g.:
pnpm -C apps/desktop build:addin
git add apps/desktop/src-tauri/resources
```

> Note: building the add-in requires closing SOLIDWORKS first (it locks the DLL).

## Guards in place

- `scripts/check-bundled-resources.mjs` runs in **both** `ci.yml` and
  `release.yml`; it fails the build if any declared `bundle.resources` file is
  missing/empty and prints each binary's `sha256` into the log for auditing.
- `tauri build` itself errors if a declared resource is missing.
- Each C# DLL stamps the **source git short-hash** into its `ProductVersion`
  (visible via file properties / `(Get-Item x.dll).VersionInfo`), so you can tell
  which source commit a shipped DLL was built from.

Neither guard can detect "present but stale" automatically — that's the rule
above. Don't skip it.
