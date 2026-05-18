# Helios Wiki

The complete user and developer guide for **Helios** — Sun Devil Motorsports' ground-station telemetry suite. A Tauri (Rust + React) desktop app for ingesting your CSV telemetry exports, overlaying multiple sessions, scrubbing through laps, computing math channels, and laying out custom workspaces of plots and gauges — and for collaborating on those files with your team through the cloud-backed **Vault**.

> **Version:** 3.2.1 · **Status:** stable
> The same pages render inside the app (**Help** button in the header, or **F1**, or `⌘K` → "Open Help & Wiki") and on GitHub.

---

## What Helios is for

Helios is the tool you reach for when you have a stack of MoTeC / Link / generic CSV exports from a test day and you want to *actually understand them* — overlay laps, build dashboards, define computed channels, share findings with the team.

The product has two parts:

- **Logs** — the analysis module. Drag in your own CSVs, build workspaces of widgets, scrub laps, compute math channels, generate reports, export results.
- **Vault** — the team layer. A Supabase-backed file store with versioning, check-out/check-in locks, and local sync. Where the squad keeps the authoritative copies of session files and shared analysis bundles.

The 56-px rail on the left of the window switches between them. Most users live in **Logs**; **Vault** is how a session file gets from the laptop that ran the logger to everyone else on the team.

> Helios ships with a few sample CSVs in the sidebar so the app isn't empty on first launch — but the moment you have your own data, drag it onto the window or use **⌘O** / **＋** in the sidebar. The samples are scaffolding, not the point.

## Typical workflows

### "I just got data off the car — let me look at it"

1. Drag the `.csv` (MoTeC, Link, or plain) onto the Helios window. Or click **＋** in the Sessions panel.
2. Helios auto-detects the format, resolves channels, and adds the file as a session.
3. If the auto-resolver picked the wrong column for any channel (vehicle-specific quirk), open **Channels** in the header and remap manually via the **Source** picker. The override persists per file.
4. Use **⌘1 / ⌘2 / ⌘3** to flip between Overview, Lap Analysis, and Engine Focus.
5. **⌘E** to enter edit mode and add the widgets you need.

### "I want to compare two sessions"

1. Load the second `.csv` the same way (drag, or **＋**, or **⌘O**).
2. Make sure both are checked in the Sessions panel; click whichever you want as the **primary** reference.
3. Strip Chart, GPS Track, XY Plot, Histogram, Lap Panel, Channel Report — all of them automatically overlay every visible session in palette colors.
4. Open **ƒ Math** to add `derivative`, `lowpass`, lap-aggregate, or any other [computed channel](06-math-channels.md). Math channels apply to every session you load, not just one.

### "I want to compare laps within a session"

1. Configure lap detection: expand the session in the sidebar (▶) → **Configure lap detection…**. Pick GPS start-finish line, beacon channel, math expression, or manual crossings. The config saves per file.
2. Click a lap row in the sidebar (or use a Lap Panel widget) to set **Main**; ⌘-click for **Ref**; shift-click to toggle **Overlay**.
3. The footer shows live `Main · Ref · Δ` once both are set.
4. The **Lap Analysis** workspace (`⌘2`) is pre-built for this — lap delta on distance, sector splits, time report, channel report.

### "We need everyone to be looking at the same files"

1. Click **Vault** on the left rail. Sign in.
2. **Browse** shows the team's shared file tree. Pick your local vault folder in **Settings** the first time; auto-sync handles the rest.
3. **Check in** uploads a new version; **check out** acquires a lock so two people aren't editing the same file simultaneously.
4. **Who has what** shows active locks. Admins can force-unlock with a reason.
5. **History** is the per-file version timeline.

### "I built a dashboard worth sharing"

1. Right-click the workspace tab → **Export…** → save the `.helios` bundle. Or **⋯** → **Export all workspaces…** for the whole set.
2. Send the file (Slack, GitHub PR, attach to a Vault file). It's a small JSON.
3. The recipient double-clicks it (the OS knows `.helios` thanks to the Tauri file association) or drags it onto Helios. Helios shows a confirm modal listing what's being imported.
4. Confirm. Workspaces append non-destructively to whatever they already have.

### "I want to take this further with code"

See the [Developer guide](10-developer-guide.md). The whole stack — loader, channel registry, math expression engine, widgets — is designed to be extended without modifying app code.

---

## Pages

### For users

1. [Getting started](01-getting-started.md) — install, first run, load your own data, persistence
2. [App tour](02-app-tour.md) — every region, every button
3. [Workspaces & tiles](03-workspaces-and-tiles.md) — layouts, edit mode, `.helios` share bundles
4. [Widgets reference](04-widgets-reference.md) — every widget, every option
5. [Channels & data ingest](05-channels-and-data.md) — CSV formats, channel registry, smart resolver, source overrides
6. [Math channels](06-math-channels.md) — expression language, scalar + time-aware ops, examples
7. [Laps & analysis](07-laps-and-analysis.md) — detection, selection, reports, distance mode
8. [Keyboard & commands](08-keyboard-and-commands.md) — full hotkey map, ⌘K palette, a11y
9. [Modules: Vault & Logs](09-modules-vault-logs.md) — Vault deep-dive: signing in, browsing, locks, sync, history

### For developers

1. [Developer guide](10-developer-guide.md) — toolchain, dev workflow, build, release, CI
2. [Changelog & feature history](11-changelog-and-history.md) — every shipped change

## Quick links

- **Install a release build:** [`docs/INSTALL.md`](../INSTALL.md)
- **Architecture overview:** [`docs/architecture.md`](../architecture.md)
- **Channel registry:** [`docs/channels.yaml`](../channels.yaml)
- **Per-issue change log:** [`v2_changes/`](../../v2_changes/)
- **UI audit follow-ups:** [`docs/ui-audit-followups.md`](../ui-audit-followups.md)

## Conventions in this wiki

- **`File paths`** are repository-relative.
- **`channel.ids`** are dotted canonical identifiers (e.g. `engine.rpm`, `gps.lat`); see [Channels](05-channels-and-data.md).
- **`⌘`** is the Mac Command key; **`Ctrl`** is the Windows/Linux equivalent.
- Hex colors quoted in `#RRGGBB` are the actual UI tokens from [`apps/desktop/tailwind.config.ts`](../../apps/desktop/tailwind.config.ts).

## Contributing to this wiki

When you ship a change that affects user-visible behavior, do **both**:

1. Add a numbered entry under [`v2_changes/`](../../v2_changes/) describing what shipped and why.
2. Update the relevant page here so the wiki stays current.

The in-app Help reads these files at runtime, so a wiki edit becomes a help-menu edit on the next launch.
