# Installing Helios

Helios ships as a native desktop app for macOS and Windows. Auto-updates run inside the app once installed; you only need this guide for the very first install.

## macOS

1. Download `Helios_<version>_universal.dmg` from the [latest release](https://github.com/NIXELFi/helios/releases/latest).
2. Open the `.dmg` and drag `Helios.app` into `/Applications`.
3. **Double-click `Helios.app`. macOS will block it** with a dialog: *"Apple could not verify 'Helios' is free of malware..."* (older macOS may say "unidentified developer"). This is expected — we don't have an Apple Developer ID code-signing cert yet. Do this once:
   - Click **Done** in the warning dialog (don't move it to Trash).
   - Open **System Settings → Privacy & Security**.
   - Scroll to the bottom — you'll see *"Helios was blocked to protect your Mac."* with an **Open Anyway** button next to it.
   - Click **Open Anyway**, confirm with Touch ID or your password.
   - Double-click `Helios.app` again — it now launches and macOS remembers the exception forever for this app.

**Power-user one-liner** that skips the System Settings dance entirely:
```bash
xattr -d com.apple.quarantine /Applications/Helios.app
```
Then double-click — no warning at all. Same effect, faster.

(Older macOS versions used to let you bypass via right-click → Open. Sequoia and later removed that path; the System Settings flow above is the supported one now.)

## Windows

1. Download `Helios_<version>_x64-setup.exe` from the [latest release](https://github.com/NIXELFi/helios/releases/latest).
2. Run the installer.
3. **Windows SmartScreen will say "Windows protected your PC."** Same reason — no Authenticode signing cert yet. Do this once:
   - Click **More info**.
   - Click **Run anyway**.
   - The installer proceeds normally.

The `.msi` variant (`Helios_<version>_x64_en-US.msi`) works the same way, with a slightly different SmartScreen dialog.

## Linux

Linux builds (`Helios_<version>_amd64.AppImage`) ship in every release as a convenience. **Auto-update is not wired for Linux** — to upgrade, download the new AppImage and replace your local copy.

```bash
chmod +x Helios_<version>_amd64.AppImage
./Helios_<version>_amd64.AppImage
```

## Updates after first install

Once Helios is installed, the **Updates** pill in the top-right of the header surfaces update state. Click it when a new version is ready, review the release notes in the modal, and click **Install and restart**. The OS scary-warnings shown above only happen on first install — auto-updates verify a Tauri-signed bundle inside the running app, so they bypass Gatekeeper / SmartScreen.

## Troubleshooting

- **"Updates" pill says "offline"** — your machine can't reach `github.com`. Auto-update isn't required for the app to function; click the pill to retry whenever connectivity comes back, or just download a new installer manually.
- **Update modal says signature failed** — never click through this. Download the latest installer from GitHub Releases manually and reinstall. (If this happens repeatedly, our private signing key may have leaked; tell a maintainer.)
