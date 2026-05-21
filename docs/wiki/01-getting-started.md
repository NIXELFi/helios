# Getting started

Helios is for analyzing **your** telemetry CSVs. The bundled samples on first launch exist only so the app isn't empty before you've loaded anything — the moment you have your own data, drop it in.

## Install a release build

If you just want to *use* Helios (not develop it), follow [`docs/INSTALL.md`](../INSTALL.md):

- Download the latest installer for your OS from the [GitHub releases page](https://github.com/NIXELFi/helios/releases).
- **macOS** — `Helios_<version>_aarch64.dmg` (Apple Silicon) or `Helios_<version>_x64.dmg` (Intel). On first launch Gatekeeper will warn — open System Settings → Privacy & Security → **Open Anyway**, since Helios is not yet OS-signed.
- **Windows** — `Helios_<version>_x64-setup.exe`. SmartScreen will warn on first install — click **More info** → **Run anyway**.
- **Linux** — `Helios_<version>_amd64.AppImage`. Make it executable and run it. (Auto-update is not wired for Linux yet.)

Subsequent updates land in-app and bypass OS warnings — they're verified by Helios's own minisign signature.

## Load your own data

Three ways to add a CSV:

- **Drag** the `.csv` file anywhere onto the app window.
- Click **＋** in the Sessions panel header to open the OS file picker (multi-select supported).
- Press **⌘O** (Mac) / **Ctrl+O** (Windows / Linux).

Helios auto-detects three flavors:

| Format | Detection | Notes |
| --- | --- | --- |
| **MoTeC i2** | `"Format","MoTeC` header | Metadata block + units row stripped automatically; duplicate `Time` columns deduplicated. |
| **Link ECU** | `"Name","ECU Internal Datalog"` preamble | Single header line stripped. |
| **Plain CSV** | Anything else | Semicolon- or comma-delimited; time in the first column. |

Unrecognized columns are still loaded — they appear in the Channel inspector under their raw header so they remain reachable. If the auto-resolver picks the wrong CSV column for a vehicle quirk, click **Channels** in the header, scroll to the canonical channel, and click its **Source** field to remap manually. The override saves per file and persists across reloads.

Each loaded CSV becomes a **session** with:

- A stable id (`user:` + djb2 hash of the absolute path) so reopening the same file restores its lap config and channel overrides automatically.
- A palette color (yellow, cyan, green, red, purple, orange, lime, teal) used as its trace color in every multi-session widget.
- An entry in the *recent sessions* list — Helios silently re-loads it on next launch unless you remove it.

To **remove** a session, hover its row and click **×**. The file stays on disk; only the in-app reference goes away.

## First five things to try (once you have data loaded)

1. **Switch workspaces** — click **Overview**, **Lap Analysis**, or **Engine Focus** in the header tab bar, or press **⌘1 / ⌘2 / ⌘3**. Each is a different pre-built dashboard.
2. **Make a session primary** — click any session row in the left sidebar. The gold **PRIMARY** badge moves; widgets that read a single session (gauges, readouts, tire grid) now point at it. Multi-session widgets overlay every visible session in palette colors.
3. **Configure lap detection** — expand the session in the sidebar (▶) → **Configure lap detection…**. Pick GPS start-finish (most common), beacon channel, math expression, or manual crossings. Lap-aware widgets light up immediately.
4. **Scrub a chart** — click anywhere on the Strip Chart or GPS Track. The yellow cursor jumps to that point and every widget on the workspace updates in lockstep. Press **Space** to start/stop playback at 0.25× to 8× speed.
5. **Open the Channel inspector** — header → **Channels**, or ⌘K → "Open Channels". Searchable, grouped view of every channel resolved in the primary session. Use **Source** to remap when needed.

Press **`?`** at any moment to see every keyboard shortcut. Press **F1** to open this wiki in-app.

## Get your team on the same data — Vault

If you're working on the team, the long-term home for session files isn't your laptop — it's the **Vault**, on the left rail next to **Logs**:

- Sign in with the email/password the team admin gave you. The session persists across launches.
- The **Settings** screen sets your local vault folder. Auto-sync runs in the background after that.
- **Browse** is the team's file tree. Check files in to upload a new version; check them out to acquire a lock.
- **History** is the per-file version timeline; **Who has what** is the active-locks dashboard.

Full walkthrough in [Modules: Vault & Logs](09-modules-vault-logs.md).

## Save and share a dashboard — `.helios` bundles

Once you've built a workspace worth keeping:

- Right-click the workspace tab → **Export…**. The output is a small `.helios` JSON.
- Header **⋯** → **Export all workspaces…** dumps every workspace at once.
- A teammate can double-click the file (the OS file association opens Helios automatically) or drag it onto the window. Helios shows a confirm modal listing what'll be imported.
- Imported workspaces append non-destructively; existing ones are not touched.

See [Workspaces & tiles → Share bundles](03-workspaces-and-tiles.md#share-bundles--the-helios-format) for the format and merge rules.

## What persists between launches

Helios persists almost everything you'd expect, locally:

| State | Where |
| --- | --- |
| Workspaces (layouts, names, colors, every tile config) | `localStorage` → `helios.workspaces.v1` |
| Active workspace, recent sessions, cursor + zoom per session, lap selection | `localStorage` → `helios.app-state.v1` |
| Per-session lap-detection config | `localStorage` → `helios.lap-config.v1.<sessionId>` |
| Per-session channel source overrides | `localStorage` → `helios.channel-overrides.v1.<sessionId>` |
| Math channels (global, applied to every session) | `localStorage` → `helios.math-channels.v1` |
| Vault auth session | Supabase auth (localStorage) |

CSV files themselves stay on disk; the recent-sessions list is just a list of absolute paths. Missing files are silently dropped on next launch with no popup.

## The bundled samples

On first launch — before you've loaded anything — Helios seeds the Sessions panel with a few sample CSVs (`SDM26-5-3-Best_Accel`, `driver_tryout_4_16__57_kaden_good_gps`, two synthetic laps) so the widgets have something to draw. They're not the point; they exist purely so the app has a non-empty default state and you can explore the UI without needing test-day data on hand.

Hide them with the checkbox, remove them with **×**. Removed bundled samples reappear on next launch (they're packaged inside the app); user-loaded files do not (they're loaded from your actual disk).

## Where to go next

- New to the layout? → [App tour](02-app-tour.md)
- Building a dashboard? → [Workspaces & tiles](03-workspaces-and-tiles.md) and [Widgets reference](04-widgets-reference.md)
- Computed channels? → [Math channels](06-math-channels.md)
- Comparing laps? → [Laps & analysis](07-laps-and-analysis.md)
- Team workflow? → [Modules: Vault & Logs](09-modules-vault-logs.md)
- Want the keyboard? → [Keyboard & commands](08-keyboard-and-commands.md)
- Working on the code? → [Developer guide](10-developer-guide.md)
