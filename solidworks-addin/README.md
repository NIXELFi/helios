# Helios Vault — SOLIDWORKS add-in

A SOLIDWORKS add-in that brings the Helios PDM vault *inside* SolidWorks:
check-in / check-out, get latest, version history, lock status — and (later)
true edit-enforcement (can't change a file unless you've checked it out).

**Windows-only** (SOLIDWORKS is Windows-only). Authored on macOS, **built and
tested on Windows.**

---

## Phase 1 (this skeleton)

A loadable add-in that registers with SOLIDWORKS, shows a **"Helios Vault"
Task Pane**, and reflects the active document's name. The buttons are
placeholders — they get wired to the Helios desktop app in Phase 3. Phase 1
exists to prove the toolchain on *your* SolidWorks install.

## Prerequisites (Windows)

- **SOLIDWORKS** installed (any recent version; the build references the interop
  DLLs from your install).
- **.NET Framework 4.8 Developer Pack** (targeting pack).
- One of: **Visual Studio 2022** (with ".NET desktop development"), or the
  **.NET SDK** (`dotnet` CLI) — either can build a `net48` project.

## Build

From `solidworks-addin/src/`:

```powershell
dotnet build -c Release
```

If your SOLIDWORKS API DLLs aren't at the default path
(`C:\Program Files\SOLIDWORKS Corp\SOLIDWORKS\api\redist`), point the build at them:

```powershell
dotnet build -c Release -p:SolidWorksApiPath="C:\Path\To\SOLIDWORKS\api\redist"
```

Output: `bin\Release\net48\HeliosVault.dll` (x64 — the `PlatformTarget` doesn't
add a path segment for an SDK-style project).

> The build needs the **.NET Framework 4.8 reference assemblies**. The project
> pulls them in automatically via the build-only `Microsoft.NETFramework.ReferenceAssemblies`
> NuGet package, so the system-wide Developer Pack is optional and the first
> build will restore from NuGet (needs internet once).

## Register (so SOLIDWORKS sees it)

COM-register the DLL **from an elevated (Administrator) prompt** — this runs the
`[ComRegisterFunction]` hooks that write the SOLIDWORKS add-in registry keys:

```powershell
# RegAsm ships with .NET Framework:
%windir%\Microsoft.NET\Framework64\v4.0.30319\RegAsm.exe /codebase "bin\Release\net48\HeliosVault.dll"
```

You should see *"Types registered successfully."* (the `/codebase` warning is
expected for a non-GAC assembly).

> **If RegAsm fails with `Could not load file or assembly 'SolidWorks.Interop.swpublished'`:**
> RegAsm runs the `[ComRegisterFunction]` hook, which loads the add-in type —
> and that type implements `ISwAddin` from the SW interops. RegAsm resolves a
> loaded assembly's dependencies from *its own folder*, so unless your SW
> install GACs the interops, copy the three referenced interop DLLs next to
> `HeliosVault.dll` first (build only; the running SOLIDWORKS resolves them from
> its own app dir, so they aren't needed there at runtime):
>
> ```powershell
> $redist = "C:\Program Files\SOLIDWORKS Corp\SOLIDWORKS\api\redist"
> $out    = "bin\Release\net48"
> Copy-Item "$redist\SolidWorks.Interop.swpublished.dll" $out
> Copy-Item "$redist\SolidWorks.Interop.sldworks.dll"    $out
> Copy-Item "$redist\SolidWorks.Interop.swconst.dll"     $out
> ```

## Test

1. Launch SOLIDWORKS.
2. **Tools → Add-Ins** → tick **Helios Vault** (both columns to auto-load).
3. The **Helios Vault** Task Pane appears on the right rail. Open a part — its
   filename shows under "Active document." The buttons pop a "coming in Phase 3"
   note.

## Unregister

```powershell
%windir%\Microsoft.NET\Framework64\v4.0.30319\RegAsm.exe /unregister "bin\Release\net48\HeliosVault.dll"
```

## Troubleshooting

- **Add-in not in the list** → registration didn't run elevated, or wrong bitness
  (must be the `Framework64` RegAsm; SOLIDWORKS is 64-bit).
- **Build can't find `SolidWorks.Interop.*`** → set `-p:SolidWorksApiPath=...`.
- **`SetAddinCallbackInfo2` / `DisplayWindowFromHandlex64` missing** on an older
  SW interop → tell me your SOLIDWORKS version; these have stable equivalents
  (`SetAddinCallbackInfo`, `DisplayWindowFromHandle`) we can swap in.

## Shipping (Phase 5): the Helios injector + tray

For end users, **nothing above is manual** — the Helios desktop app provisions
the add-in itself:

- On every launch, Helios (`apps/desktop/src-tauri/src/addin_injector/`) detects
  SOLIDWORKS, stages the bundled, version-stamped `HeliosVault.dll` into a
  per-version folder, and registers it — no RegAsm. The managed-COM **CLSID** and
  the per-user **enable flag** are written per-user (HKCU, no admin). The one
  thing that needs admin is the **discovery list entry**
  `HKLM\SOFTWARE\SolidWorks\AddIns\{guid}` — SOLIDWORKS finds add-ins ONLY there
  (no HKCU discovery) — so the injector writes it via a **one-time elevated step
  (single UAC), skipped once present**. If the user declines, "Install / repair
  SOLIDWORKS add-in" in Settings retries it. It updates automatically (versioned
  folders, so a new DLL never collides with one a running SW has loaded) and
  notifies the user to restart SW when needed.
- Helios runs minimized in the **system tray** (close → hide, quit from the tray)
  with **auto-start on login**, so the localhost bridge is always live and the
  add-in shows **"● Connected · \<you\>"**.

**Building the Windows installer** (must run on a Windows box with the add-in
toolchain, since it builds the DLL that gets bundled):

```powershell
cd apps/desktop
pnpm build:win   # = pnpm build:addin (dotnet build + stage DLL) && pnpm tauri build
```

The prebuilt `apps/desktop/src-tauri/resources/addin/HeliosVault.dll` is
**committed to the repo**, so the bundle can include the add-in even on a build
machine without the .NET toolchain. Rebuild + recommit it after add-in changes
with `pnpm --filter @helios/desktop build:addin`. The dev/manual `regasm` flow
above still works for add-in development.

See `HANDOFF.md` for the architecture, roadmap, and how to continue this work in
a Claude Code session **on the Windows machine**.
