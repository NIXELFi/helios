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

Output: `bin\x64\Release\net48\HeliosVault.dll`.

## Register (so SOLIDWORKS sees it)

COM-register the DLL **from an elevated (Administrator) prompt** — this runs the
`[ComRegisterFunction]` hooks that write the SOLIDWORKS add-in registry keys:

```powershell
# RegAsm ships with .NET Framework:
%windir%\Microsoft.NET\Framework64\v4.0.30319\RegAsm.exe /codebase "bin\x64\Release\net48\HeliosVault.dll"
```

You should see *"Types registered successfully."* (the `/codebase` warning is
expected for a non-GAC assembly).

## Test

1. Launch SOLIDWORKS.
2. **Tools → Add-Ins** → tick **Helios Vault** (both columns to auto-load).
3. The **Helios Vault** Task Pane appears on the right rail. Open a part — its
   filename shows under "Active document." The buttons pop a "coming in Phase 3"
   note.

## Unregister

```powershell
%windir%\Microsoft.NET\Framework64\v4.0.30319\RegAsm.exe /unregister "bin\x64\Release\net48\HeliosVault.dll"
```

## Troubleshooting

- **Add-in not in the list** → registration didn't run elevated, or wrong bitness
  (must be the `Framework64` RegAsm; SOLIDWORKS is 64-bit).
- **Build can't find `SolidWorks.Interop.*`** → set `-p:SolidWorksApiPath=...`.
- **`SetAddinCallbackInfo2` / `DisplayWindowFromHandlex64` missing** on an older
  SW interop → tell me your SOLIDWORKS version; these have stable equivalents
  (`SetAddinCallbackInfo`, `DisplayWindowFromHandle`) we can swap in.

See `HANDOFF.md` for the architecture, roadmap, and how to continue this work in
a Claude Code session **on the Windows machine**.
