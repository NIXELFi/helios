# Changelog

All notable, user-facing changes to Helios are recorded here, newest first.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [semver](https://semver.org/).

<!--
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ AGENTS & CONTRIBUTORS — READ THIS BEFORE YOU FINISH A CHANGE.             │
  │                                                                           │
  │ Every user-facing change MUST get a bullet under [Unreleased] below, in   │
  │ the right group (Added / Changed / Deprecated / Removed / Fixed /         │
  │ Security). THIS FILE IS THE SINGLE SOURCE FOR RELEASE NOTES:              │
  │                                                                           │
  │   CHANGELOG.md  →  GitHub release body  →  team Slack channel             │
  │                                                                           │
  │ At release time `node scripts/bump-version.mjs <version>` promotes        │
  │ [Unreleased] to a dated version section; the Release workflow             │
  │ (.github/workflows/release.yml) drops that section into the GitHub        │
  │ release body and posts it to Slack. `scripts/check-versions.mjs` FAILS    │
  │ the release if the tagged version has no section here — a missing         │
  │ changelog blocks the release. So: if you don't add your entry here, your  │
  │ change does not propagate. (Older per-change dev-notes live in            │
  │ v2_changes/ and in past GitHub releases.)                                 │
  └─────────────────────────────────────────────────────────────────────────┘
-->

## [Unreleased]

### Fixed

- **Plinko drops failed with a database error.** The ball's path is generated
  server-side by pgcrypto, which lives in a schema the drop routine wasn't
  looking in, so every drop was rejected the moment you released the ball.
  Nothing was charged for a failed drop and no other game was affected. Fixed
  server-side — no app update needed.

## [5.6.0] - 2026-08-26

### Added

- **Blackjack now plays for the subteam's money too.** The 200-chip stack the
  table used to hand you is gone: chips come from the shared budget, capped at
  5% per bet like everything else in the casino, and doubling down takes a
  second, separately capped stake. The chips leave the budget when the cards
  come out and come back when the hand finishes. **Leaving mid-hand forfeits
  the bet**, exactly like walking away from a live table — the cabinet clears
  any hand left open by a previous session when you sit down.
- **Casino: shared subteam money.** Every subteam now has one chip budget,
  seeded at 10,000, that all of its members spend from. A single bet can never
  be more than 5% of what the budget currently holds, checked against the live
  balance at the moment the bet is placed — so two teammates playing at the
  same time can't both spend the same chips.
- **Plinko** joins the casino, spending that shared budget. Three risk levels
  and 8/12/16-row boards, every one of them returning ~99% (deliberately close
  to blackjack's chart edge, so the choice is about variance rather than a
  worse deal). The ball is dropped by the SERVER — the path, the bucket, the
  payout and the ledger row all land in one transaction, and the cabinet only
  animates the result.
- **Casino standings are now chips on hand.** The arcade's placement-points
  scoring exists to make incomparable scores comparable; the casino has one
  shared pot per subteam, so the pot is the score. A money game's own boards
  show chips won and lost per member, which are frequently negative.

### Changed

- **The blackjack leaderboard is money now, not rating.** Chips are what the
  casino competes on; your rating became a personal number, still shown in the
  cabinet and still earned per hand exactly as before. It is NOT reset — it
  keeps scoring your play against the same 200-chip reference stack it always
  has, so a rating earned last week means the same thing this week. Stakes
  above 200 chips play for money rather than for rating.

### Security

- Blackjack payouts are checked server-side against the only amounts a legal
  hand can produce (nothing, the stake back, twice the stake, or the 3:2
  natural on an unraised hand), and a player can have only one hand open at a
  time.
- Budgets and the bet ledger are readable by the team but writable only
  through the security-definer RPCs, so the 5% cap and the ledger row cannot be
  bypassed by talking to PostgREST directly. Every bet carries an idempotency
  nonce: a retry after a dropped connection replays the original ball instead
  of rolling a second one and charging for it twice.

## [5.5.1] - 2026-08-18

### Changed

- **Blackjack rating is now "skill money" — betting big on good play climbs
  instead of bleeding.** The previous formula quietly charged for any raise
  above the table minimum at a neutral count, so three of the four chip
  buttons lost rating even when played perfectly ("I win hands and still drop
  Elo"). The rating is still built on what your decisions and bets were
  *worth* — luck stays a separate stat — but it's now denominated in expected
  chips: flawless play at a 100-chip bet earns twenty times the climb of the
  same play at the minimum, sloppy play at 100 chips digs twenty times the
  hole, raising into a rich count pays extra, and only all-in spam pays a
  risk premium. Mimic-the-dealer still sits at 1000 and flawless flat-minimum
  play at 1400, but 1400 is no longer the ceiling. Because the scale changed,
  **everyone's blackjack rating has been reset to 1000** for a fresh climb;
  sessions from app versions older than this one no longer move the ladder.

## [5.5.0] - 2026-08-17

### Changed

- **Dashboard layouts are now shared and permanent.** Each dashboard (a
  subteam's, or the all-team one) now has a single layout shared by everyone
  who views it, saved on the server — so it survives reboots, app updates, and
  switching machines instead of living only in one machine's browser storage.
  Editing (Customize, tabs, widgets) is limited to those holding the
  manage-dashboard capability in that scope: a subteam's Leads/VPs, or
  Executives/Owners for the all-team dashboard. Which tab you're looking at
  stays your own. The first time an editor with a customized layout opens a
  dashboard that has no shared layout yet, that layout becomes the shared
  one — no edit required. If the network is down the dashboard shows the
  last layout your machine saw and says so, and an edit that didn't reach
  the server is re-sent on the next launch (unless someone else has saved a
  newer layout since — the newer save wins). The layout each machine had
  before this change is kept locally as a one-time backup.

## [5.4.1] - 2026-08-11

### Changed

- **Blackjack is now rated on how you play, not on whether you won.** The old
  score treated every hand as a coin flip against a fixed-1000 house, which
  made it mathematically unwinnable — under these house rules a flawless
  basic-strategy player scores about 0.478 per hand against an expectation of
  0.5, so perfect play drifted down to roughly 985 and could never hold 1000.
  It also paid you the same for being dealt 20 against a 6 as for grinding out
  16 against a 10, and rewarded hitting a hard 20 if you got away with it.
  Your rating is now driven by the expected value of your decisions and your
  bet sizing, computed exactly, with the cards that actually fell excluded.
  Every hand shows what it cost you and what the chart wanted instead, and
  "luck" is reported as its own number so you can see the shoe robbing you
  without it touching the ladder. The landmarks: play like the house rule
  (draw to 17, never double) and you sit at 1000; flat-bet the minimum and
  never misplay a hand and you settle at 1400; above that is earned only by
  raising your bet when the shoe is genuinely rich, and by not going broke.
- **Your blackjack rating now carries across sessions.** It is a number you
  hold, not a high score you beat: the board shows what you are on right now,
  so it can go down, and a hot three-hand cash-out is worth about a tenth of a
  full session instead of topping the leaderboard. Sessions are weighted by
  length and applied server-side, and the rating settles more slowly the more
  hands you have behind you.
- Blackjack's weekly board is now "biggest climb this week" rather than a best
  score, and the casino subteam standings count how far members have climbed
  above 1000 (so they measure a subteam's play, not its headcount).
- ALL-IN finally costs something on the scoreboard: staking a large slice of
  the bankroll is priced as the risk it is, separately from expected value.

## [5.4.0] - 2026-08-10

### Added
- **The Games tab has a casino now.** The lobby heading splits into ARCADE / CASINO — click to switch rooms (Helios remembers which one you were in). First table in the back room: **Blackjack**. House chips only: sit down with 200, bet with 5/25/100 chips (or shove all-in), hit/stand/double against a dealer who stands on all 17s, blackjack pays 3:2. Bust the bankroll and the session is over; cash out to bank your result. Your leaderboard score is an **Elo rating**, not chips — every hand is a rated game against a fixed-1000 house (win 1, push ½, loss 0), so climbing above 1000 means beating the house edge, and the further you climb the harder every point gets. The table shows your live rating, per-hand swing, and W-L-P record; keyboard players get H/S/D and Enter. The casino keeps **its own standings** — its boards and subteam points live entirely in the casino room, so the arcade Grand Prix is exactly what it was before.



### Added
- **A Values panel — the readout table i2 users live in.** New "Values" widget: pick your channels and see each one's value under the cursor for every visible session, side by side, with a Δ-vs-primary column when you're overlaying runs and min/max/avg over whatever you've zoomed to. Channel names, units, and decimal places come from the channel registry, so `engine.rpm` reads "RPM" with no decimals instead of "10234.00".
- **Arrow keys scrub the cursor.** ←/→ nudge the cursor by a fraction of what's on screen (hold Shift for coarse steps, hold the key to keep scrubbing) — the further you zoom in, the finer the step. ⌘/Ctrl+arrows still do text navigation.
- **`U` zooms back out one level.** Every zoom you make is remembered (up to 32 deep), so drilling into a corner and pressing `U` walks you back the way you came instead of dumping you at the full session. Also in the command palette as "Zoom out one level".
- **Datum markers can finally be removed one at a time.** Alt-click (Option-click on Mac) near a datum line deletes just that marker; "Clear datums" still clears them all. The shortcuts overlay documents both.
- **Gauges can now alarm low.** Bar gauge, round gauge, and numeric readout accept "warn below" / "alarm below" thresholds alongside the existing high-side pair — so oil pressure, fuel pressure, and battery voltage can go amber and red on the way down, with matching low-side tick marks and arc bands. The numeric readout's thresholds are also editable from the config panel for the first time.
- **The strip chart's "x = time" pill is now a real button.** Click it to flip between time and distance axes without opening the config panel — the toggle the pill's tooltip always promised.
- **Sessions can be renamed and recolored.** Double-click a session's name in the sidebar to give it a label that means something ("Kaden stint 2" instead of a log filename) — the rename shows up everywhere the session is named, and the tooltip still tells you which file it came from. Click the color chip next to the name to pin the trace color, or set it back to auto. Both survive restarts, and re-adding the same file later brings them back.
- **Hidden sessions stay hidden.** The visibility checkbox is now remembered per session, so the runs you unchecked yesterday don't all flood back onto every widget at the next launch. Explicitly re-opening a file always brings it back visible.

### Changed
- **The workspace tab bar stays visible while editing.** Entering edit mode used to hide the tabs entirely, leaving ⌘1-9 as the only way to switch workspaces mid-edit.
- **Big files load faster, without freezing the app.** Session data now crosses from the loader to the UI as raw binary instead of being expanded into JSON text (which inflated it roughly 4×) and is unpacked in bulk rather than value by value — and the parse itself runs off the window's thread, so Helios stays responsive while a large CSV loads instead of locking up.
- **Tile headers say what the tile is.** Headers used to show an internal id like `strip-chart-2`; now they show the widget's name plus what it's configured to display ("Strip Chart · RPM, Throttle"), and you can give any tile your own title from its config panel.
- **Dashboards are all data now.** Outside edit mode the per-tile title bar no longer takes a strip of every tile — the header fades in when you rest the pointer on a tile, and edit mode keeps the full bar as the drag handle.
- **Charts use Helios's own typeface.** Axis labels on the strip chart and Lap Δt rendered in the browser's fallback font; they now use the same monospace numerals as the rest of the app. The strip chart's live readout also shows channel display names, registry decimal places, and units — "RPM 10234" instead of "engine.rpm 10234.00" — and the FFT, XY plot, and histogram headers got the same naming treatment.
- **The Add Tile menu is scannable.** Widgets are grouped into Charts, Gauges, Timing, and Data sections, each entry led by a small pictogram of the widget — instead of nineteen identical text cards.
- **Empty widgets all explain themselves the same way.** Every "nothing to show yet" state now says what's missing and how to fix it, in one voice — "No laps detected · Configure lap detection in the Sessions panel" — where the wording, casing, and styling used to differ per widget. Config-panel inputs and dropdowns share one control style too.

### Fixed
- **Lap Δt and Sector Splits actually work now.** Both widgets need a speed channel to build their distance axis, but the app never included one in the data it handed them — so they permanently showed "sessions need a speed channel" no matter what you loaded. They were also missing from the Add Tile menu. Both are fixed; the speed channel your Lap Config picks now takes priority over the built-in guesses, for the distance-mode strip chart too.
- **The FFT and XY plot honor the zoom window again.** Both advertise "analyze the zoomed range", and both silently kept showing the range from when the tile first drew. Drag-zooming a strip chart now genuinely recomputes the spectrum and refilters the scatter.
- **Overlaid sessions draw as continuous lines.** Two runs whose sample clocks didn't line up exactly rendered as fields of disconnected fragments in time mode — the core comparison workflow looked broken. (Trade-off worth knowing: a genuine logger dropout is now bridged by a straight line rather than a gap.)
- **Peak-hold markers stop resetting themselves.** The peak tick on the bar gauge and engine bar was wiped by any unrelated click in the app (selecting a lap, toggling a panel). It now resets only when you switch session, channel, or data range — which is what "peak hold" was supposed to mean.
- **A stalled engine reads "0", not "—".** The engine bar treated zero rpm as missing data; zero is real data. Genuinely missing samples still show the dash (and no longer render as the literal text "NaN" before the first sample arrives).
- **`highpass()` math no longer jolts after a data gap.** A single NaN sample reset the filter's internal state to zero, injecting a full-amplitude step into the output at every dropout. The filter now holds its state across gaps and resumes cleanly — damper-velocity math built on `highpass()` is trustworthy around dropouts again.
- **Time Report: the best lap's "Δ best" column shows 0.000 instead of a dash**, and the report no longer recomputes itself on every unrelated UI update.
- **Zone Stats no longer rescans the whole session on every cursor tick** in live datum→cursor mode — the window is found by binary search now, so long sessions stay smooth while scrubbing.
- **A missing sample no longer reads as zero.** When the loader marked a sample as absent, the value handed to widgets quietly became 0 — indistinguishable from a real reading of zero. Absent samples now come through as gaps, the same way math-channel gaps already behave.

## [5.3.2] - 2026-08-04

### Fixed
- **The Vault stops re-downloading the entire file list every 15 seconds.** Helios keeps an eye on your vault with a cheap "has anything changed?" check, and only reloads the full catalog when the answer is yes. One part of that check was asking the server a question it couldn't answer, so it failed every single time — and a failed check is treated as "something changed", which meant every open Vault window quietly re-pulled the whole catalog (thousands of files) four times a minute, forever. The check now works, so an idle vault costs almost nothing. Expect the Vault to feel faster and your network usage to drop sharply.

### Security
- **Releases are now verified before they reach you.** Every installer and update package is re-downloaded and cryptographically checked against Helios's signing key before a release is published. A damaged or tampered download now blocks the release instead of reaching your computer — see the v5.3.1 note below.

## [5.3.1] - 2026-07-31

_Re-released 2026-08-04._ The originally published Windows and Intel-Mac downloads were corrupted after the build and could not be installed or updated to; Apple Silicon and Linux were unaffected. All downloads were rebuilt, signature-verified, and republished under the same version. If Helios told you an update failed, it will now install normally.

### Fixed
- **Vault no longer deletes your local working copies when the folder list arrives incomplete.** If a folder in the middle of a file's path hadn't loaded yet, Helios computed a shortened path (`Frame/part.sldprt` instead of `Chassis/Frame/part.sldprt`). That path matched nothing, so clean read-only working copies looked like leftovers from a moved file and were removed. Vault now treats a folder chain it can't fully verify as "unknown" and skips those files for the pass instead of acting on a guess — the same rule that already protects files whose own folder is missing.
- **Bulk "Check In Changes" no longer leaves files checked out to you when the check-in fails.** If a part was open in SOLIDWORKS (or the upload failed), the file was reported as failed but stayed locked to you, and only an admin could clear it. The lock is now handed back on every failure, including when you change your selection mid-run. The same applies to bulk Check Out if you navigate away while it's downloading.
- **Folders whose names Windows can't store verbatim now sync.** A folder named `Rev1.` or one containing `:` `*` `?` `"` `<` `>` `|` produced a path Windows silently rewrote, so those files were re-downloaded every pass and never showed as in sync. Such names are now mapped to a valid folder name (as vault names already were), including the reserved names `CON`, `NUL`, `COM1`, and friends.
- **Adding a file no longer files it into a similarly-named folder.** A folder name containing `*` was treated as a wildcard when looking for an existing folder, so a file destined for `R*D` could land in `RandD`. Names are now matched literally, and an unexpected match creates the correct folder rather than reusing the wrong one.
- **The SOLIDWORKS add-in refuses to act when two vaults share one folder.** Vaults whose names differ only by capitalisation map to the same folder on disk; the add-in used to pick whichever came first, so a check-in could land in the wrong vault. It now reports a clear error instead.
- **Check-out rollback tells you the truth.** When a check-out couldn't be completed, Helios said the check-out was rolled back even if releasing the lock had also failed. If the file is still checked out to you, it now says so and points you at Undo check-out.
- **A hiccup talking to the server no longer fails a check-in of content already stored.** A momentary error while checking whether the content was already uploaded turned what should have been an instant check-in into a hard failure with your file still checked out.
- **The "Importing dropped files…" banner always clears.** Cancelling or superseding a drag-and-drop import left the banner up until you left the Vault screen.
- **An update that installs but can't restart Helios no longer looks like a network error.** Previously the app fell back to a restart path that isn't shipped in the bundle, so the failure surfaced as a misleading "offline" pill on a perfectly good, already-installed update. You now get a clear "Helios vX.Y.Z is installed — please restart Helios manually" message instead.
- **A bulk task edit you're only partly allowed to make no longer looks like it saved.** Selecting tasks across subteams and changing them in one go reported success even when permissions blocked some of them, and those rows quietly reverted on the next refresh. Helios now detects the partial save, undoes the on-screen change, tells you how many rows actually changed, and reloads from the server automatically so what you're looking at is what really saved.
- **A failed save while you're switching projects now tells you.** If an edit was rejected after you'd already moved to another season, the error was discarded and the change vanished with no message. You now get the error, and it names the project the edit belonged to.
- **Project Management no longer reverts recent edits about once an hour.** Your sign-in is refreshed periodically in the background; PM mistook that for a new sign-in and reloaded itself from an older cached copy, undoing edits made since. It now ignores refreshes of the same account.
- **Your PM project selection is no longer shared with whoever signs in next** on the same computer. (Everyone will pick their project once more after this update.)
- **Undoing a check-out no longer silently discards your edits when the restore fails.** If Helios couldn't fetch the vaulted copy back, it still marked your file as a clean synced copy, so a later Get Latest overwrote your work without warning. The file is now left as-is and you're told the restore didn't happen.
- **Get Latest refuses to overwrite a file it can't inspect.** If the file was locked by SOLIDWORKS or blocked by permissions, the safety check that protects unsaved edits was skipped entirely and the file was overwritten. Helios now stops and explains instead of guessing.
- **A file checked out by a teammate no longer keeps showing as available** until you restart Helios, and an admin force-unlock now becomes visible right away.
- **An assembly Helios can't read no longer wipes its "where used" links.** An unreadable assembly file was treated as one with no references at all, erasing the relationships that Get Latest with references depends on. It's now reported as a read failure and the existing links are left intact.
- **Uninstalling an add-on now asks first.** The trash icon sat right next to Open and removed the add-on and its saved data immediately, with no undo.
- **A failed add-on update no longer leaves you with no add-on at all.** The old version was deleted before the new one was unpacked, so an update that failed verification removed the working copy while still showing as installed. The previous version now stays in place unless the new one is fully verified.
- **Add-on data is no longer visible to the next person who signs in** on a shared computer, and is now erased when you uninstall. Your own saved add-on settings carry over to the new per-person storage.
- **Dragging files onto a folder that hasn't finished loading no longer dumps them at the top of the vault.** Helios now says to refresh and try again instead of importing them to the wrong place.
- **Launch-on-login no longer turns itself back on (macOS/Linux).** The marker recording your launch-on-login choice was written to a temporary folder the OS periodically clears, so a few days later Helios treated you as a first-run user and silently re-enabled launch-on-login. It's now stored in Helios's own app data folder. Existing Windows preferences are read from the old location too, so nothing changes for you there.

- **The Lap Sim brake trace now reads as a true percentage of available braking.** On endurance laps the channel was measured against full-attack grip rather than the managed pace the lap is actually driven at, so a driver at the limit showed roughly 55-60% brake. Lap times are unaffected — only the displayed trace changed.
- **Engine configs with mismatched pipe counts are rejected with a clear message** instead of crashing the solver mid-run, and headers whose runners or collectors genuinely differ from each other now use their real per-pipe geometry instead of copying the first pipe's. No shipped SDM25/SDM26 config changes behaviour.
- **Traced tracks respect the minimum-corner-radius floor** after length scaling rather than before, so a scaled trace no longer ends up with corners tighter or looser than the floor intended.

## [5.3.0] - 2026-07-24

### Added
- **Windows now gets a custom Helios title bar.** The stock Windows frame is replaced by an in-app bar that matches the rest of the app — the Helios logo + wordmark, the module you're in, and minimize/maximize/close controls (close hides to tray, exactly like before). Drag, double-click to maximize, Win+arrow snapping, and edge snapping all still work. The sidebar no longer repeats the wordmark on Windows (the title bar owns the brand). macOS is unchanged (native traffic lights).

### Fixed
- **Modals no longer cover the Windows title bar.** Full-screen dialogs, backdrops, and pickers now start below the custom title bar, so you can always drag, minimize, or close the window even while a modal is open.
- **No more white flash while Helios starts up.** The window now opens with the app's dark background instead of a blank white webview, and a small spinner appears (only if startup takes more than a moment) until the interface finishes loading.

## [5.2.3] - 2026-07-23

### Fixed
- **Vault — no more phantom "file was deleted / added" detections.** The local-sync engine treated "absent from a snapshot" as truth, and several windows made snapshots stale or wrong. All are closed:
  - **Vault switch no longer mass-warns "deleted locally — restored from vault" or re-downloads the whole vault.** The previous vault's disk scan stayed published while the new vault's (slow, full re-hash) scan ran, so the new vault's files all looked locally deleted — and a writable local file with unsaved work could be overwritten. The scan now drops its snapshot the instant the root changes, and every consumer verifies the snapshot came from the active vault's folder.
  - **A missing/unplugged vault drive can no longer soft-delete your checked-out files.** Restarting Helios with the vault root unreachable published an empty scan while the sync ledger still listed everything this machine had downloaded — classifying every file "locally deleted" and propagating vault-wide deletes for checked-out ones. Deletion inference now stands down when the root is missing, and a completely empty scan with a populated ledger is treated as an observation problem, never a mass delete.
  - **A file SolidWorks (or antivirus) is holding open is no longer reported as "deleted locally".** The scanner silently skips files it can't read; the sync pass now re-probes the disk before warning or restoring, so an unreadable-but-present file is left completely alone.
  - **Files whose folder hasn't loaded yet are skipped instead of being downloaded to the vault root.** A teammate's folder restore / bulk import could momentarily reference a folder the app hadn't fetched; the path silently collapsed to the vault root, stranding orphan copies (which then looked like phantom "new local files"). Every disk-touching path (sync, check-in, get-latest/get-version, bulk actions) now refuses to act on an unresolvable folder for that pass — check-in in particular could previously read an unrelated same-named root file's bytes and publish them as a new version.
  - **Deleting a folder now cleans up teammates' local copies of its files.** The reaper resolved deleted files' paths against live folders only, so a folder-cascade delete left the whole subtree on everyone's disk forever (reading as phantom "add" candidates) — and could even delete an unrelated same-named root-level file. It now resolves against the combined live+deleted folder set.
  - **Moving a file no longer leaves a stale copy at the old path on everyone else's machine.** The reaper now removes read-only local copies that this machine materialized from the vault (ledger-verified, byte-identical) once no vault row maps to their path — writable or user-created files are never touched.
  - **"Add to vault" candidates are only computed from a consistent snapshot.** During a vault switch, local files could be diffed against the other vault's file list and genuinely added as drafts into the wrong vault.
  - **The SOLIDWORKS add-in can no longer resurrect a deleted file.** The bridge's file snapshot included recycle-bin files (so Get Latest could re-materialize one), and bridge downloads weren't recorded in the sync ledger (so auto-add re-vaulted the copy as a "new" file, silently undoing the delete). Both fixed.
  - **Case-variant duplicate folders/files are no longer created.** The DB treats `Chassis` and `chassis` as different, but Windows/macOS map them to one directory — an add whose on-disk case differed created a twin row that then fought the original over the same local file (endless re-download churn). Folder/file lookups are now case-insensitive client- and server-side (migration `20260723000000`; inserts keep the exact case you typed).

## [5.2.2] - 2026-07-22

### Fixed
- **PM — members onboarded through Org & Access can edit tasks in the UI.** The PM module read roles from the legacy membership table only, so anyone granted access via Org & Access (the standard path) saw every edit control disabled with "You don't have access…" even though the server accepted their edits. `my_team_roles` now reports the same effective role the server's edit rules use (migration `20260722000000`).
- **Vault — capability-granted admins get their admin controls.** The "New vault" form (Vault switcher) and the Insights spotlight picker were gated on the legacy global admin probe, hiding them from admins granted via Org & Access capabilities (and, for spotlight, from per-vault admins) — the server accepted both all along. Both now probe the same rule the database enforces.
- **Org & Access — role editors and structure editors can reach the tool.** The rail entry only admitted role-granters; an account holding just Manage-roles or Manage-org-structure couldn't open the module its capabilities serve. The People tab hides for accounts the server's people-directory would refuse, instead of erroring.
- **Org — leads can assign roles again.** The "+ role" button in People & Roles never appeared for subteam leads: the button's gate only recognized *org-wide* grant capabilities, while a lead holds `pm.grant_subteam_roles` scoped to their subteam (the server accepted lead grants all along — only the button was missing). The button now appears whenever there is at least one role the signed-in user can actually grant. Role chips likewise only show their remove (×) button when the revoke would be accepted — leads no longer see remove buttons on org-wide or other-subteam roles that always failed with a permissions error.

### Security
- **SOLIDWORKS bridge: `checkin` and `getLatest` are now confined to the vault folder**, like `add` already was. Before, a caller holding the per-launch loopback token could point `checkin` at any local file (arbitrary read → exfiltrate into the vault) or `getLatest` at any destination (arbitrary write). Both ops now refuse paths that don't resolve to a location inside a vault folder.

## [5.2.1] - 2026-07-21

### Changed

- **Bug-report screenshots are now capped at 10 MB and must be images**
  (PNG, JPEG, WebP, or GIF). The Report modal explains the rejection inline
  instead of failing on upload, and the storage bucket enforces the same cap
  server-side.

### Fixed

- **Two admins removing owners at the same moment can no longer leave the org with zero owners.**
  Owner-revokes are now serialized, so the second removal always sees the first and the
  "cannot remove the last owner" guard holds under concurrency.
- **Performance-sim vehicle inputs now refuse zero and negative physical values.**
  Typing 0 into mass, track, wheelbase, tire radius, CG height, driveline η, or air density
  used to silently turn accel and lap-sim results into NaN; those fields now only accept
  sane positive values.
- **Slack notifications no longer silently drop an edit when two people touch the same task at the same moment.**
  The notification queue now coalesces concurrent edits atomically instead of discarding the
  loser's update.
- **Adding an identical file to the vault now matches its checksum regardless of letter case.**
  The add-and-lock duplicate check compared SHA-256 hashes case-sensitively (unlike check-in
  and restore), so an uppercase-hex client would be wrongly told the file "already exists with
  different content".

## [5.2.0] - 2026-07-21

### Added

- **Accounts can now be deleted from Org & Access → People & Roles.** A trash
  button on each person row (with a confirmation) permanently deletes the
  account: releases their checkouts, un-assigns their work, and preserves
  authorship history as an unknown user. The action previously only existed on
  an unreachable legacy vault screen. Org admins (anyone who can grant roles)
  can delete regular members; admin-tier accounts — role carrying
  `org.grant_roles` or `org.manage_admins`, or a legacy global admin — can only
  be deleted by the owner. Profile edits (name / signup subteam) follow the
  same rules.

### Fixed

- **A deleted folder's name can be used again.** Creating a folder with the
  same name, in the same place, as one sitting in the recycle bin used to fail
  with a raw "duplicate key" error — permanently, because the recycle-bin entry
  still owned the name. Creating it now revives that folder, empty; its old
  contents stay in the recycle bin and restore exactly as before. Applies to
  the New-folder button, drag-drop imports, Add-from-local-folder, and the
  SOLIDWORKS bridge alike.
- **Failed local-file adds no longer strand empty folders.** When adding a file
  creates its folder path and a later step fails (unreadable file, upload
  error), the add now removes the folders it had just created instead of
  leaving empty husks behind in the vault tree.
- **Renaming or deleting a subteam no longer leaves its old name in the signup
  picker.** The signup picker offers a merged list of the org registry and a
  legacy seed table that only an unreachable admin screen could ever edit — so
  a renamed or deleted subteam's old name stayed on offer to new signups
  indefinitely. A database trigger now keeps the legacy half in step with
  every registry change (made in Org Structure or the PM sidebar alike), and
  the orphaned legacy picker-editing functions lost their execute rights.

### Removed

- **The orphaned vault "Users & roles" admin screen was deleted.** Nothing
  linked to it since the Org & Access module took over role management; its two
  remaining unique abilities (account deletion, signup-picker subteam edits)
  moved into Org & Access, above.

## [5.1.2] - 2026-07-16

### Security

- **The SOLIDWORKS bridge "add to vault" now refuses paths that escape the vault folder.**
  The bridge matched a local file to its vault with a purely textual
  prefix check, so a crafted path with `..` segments that still began with a vault
  folder (e.g. `…/SDM26/../../../.ssh/id_rsa`) passed the check while the file it
  actually read lived outside the vault — a caller could pull an arbitrary local
  file into the vault. Reaching the bridge at all requires the machine-local,
  per-launch token (it is not remotely reachable), so this was never web- or
  network-exploitable, but the add path now rejects any `..`/`.`, absolute, or
  drive-relative remainder. Found by the red-team review below.

### Security review response

- **Red-team assessment (Sam, 2026-07-15) reviewed and triaged.** A member ran an
  authorized red-team of the Vault authorization model against a throwaway copy of
  the database. It was good work — the reproduction was clean and one real finding
  came out of it (fixed above). Full verdicts and decisions follow so everyone has
  the same picture.
- **Cross-vault access (reported HIGH): intended for now, not a regression.**
  Any member with a role can currently read every vault (`vault.view` is carried by
  every role), and members whose role also carries `vault.edit` (Engineer and up in
  our current role config) can write across vaults too — so the finding is real and
  the reproduction is accurate. This is deliberate and documented in the code:
  subteam roles are subteam-scoped while vaults are season-scoped, with no
  vault-to-subteam mapping yet, so a vault capability grants team-wide access — the
  same team-wide model we had under the old "global viewer row" rows. It was not
  introduced by the July capability-bridge migration and is not a regression; the
  same day's default-deny change actually tightened access (a brand-new signup now
  gets nothing until a lead grants a role). Decision: for a single FSAE team sharing
  its own CAD, team-wide access is acceptable today; true per-subteam isolation is
  deferred until the vault-to-subteam mapping lands, which is the real fix if and
  when we decide to wall subteams off.
- **Bridge arbitrary-file "add" (reported MED): fixed this release.**
  See Security above. Real, but gated behind the machine-local bridge token.
- **Marketplace signature omits declared permissions (reported MED): already defended.**
  Install already refuses any bundle whose
  manifest requests a permission that was not consented and reviewed, and the
  bundle's manifest is covered by the signed content hash — so a plugin can never run
  with more than the user approved. Signing the separately-submitted database
  manifest as well is out of scope by our stated threat model (it does not defend
  against a full database compromise, which could read the signing key regardless).
- **Native commands could amplify a future in-app XSS (reported MED): acknowledged, tracked.**
  There is no known XSS today; this is defense-in-depth. Scoping the
  sensitive Tauri commands is tracked for a dedicated hardening pass rather than a
  patch release.
- **Forgeable game scores + vulnerable deps (reported LOW): accepted / routine.**
  Leaderboard scores on an internal team game do not warrant per-game
  server-side validation right now (a blunt cap would reject legitimate scores). The
  dependency advisories are low-impact for a desktop tool; patch-level fixes ride
  this release's lockfile refresh, and anything needing a major version bump is
  tracked separately.
- **Confirmed solid (credit where due):** no secrets in the repo or its history; the
  loopback bridge auth (per-launch token, Origin rejection, loopback-only bind), the
  server-side role re-checks on sensitive actions, the default-deny pass, and the
  asu.edu signup gating all held up under testing.

## [5.1.1] - 2026-07-14

### Security

- **Default-deny for accounts with no role — team data is IP.** A brand-new
  signup no longer gets any access: the automatic baseline vault role is gone,
  and the remaining world-readable tables (vault list, PM reference data,
  dashboard photos, synced calendar, games leaderboards, marketplace listings
  and bundles, telemetry storage) now require an org role. Instead of empty
  screens, role-less accounts see a clear "contact your team lead" page with
  a one-click re-check once they've been added.

### Fixed

- **Roles granted in Org & Access now work everywhere.** Members whose only
  role comes from the org tool (Engineer, Lead, VP, …) can now open the Vault
  (the module's access check consulted only the legacy role table and told
  them they weren't authorized), create and edit PM tasks (task permissions
  had the same gap), and — for leads and execs — open the Org & Access tool
  itself and manage vaults.
- **PM Slack notifications are flowing again.** A stuck retry wedged the
  notification queue on June 30 and every dispatch since failed silently; the
  dispatcher now supersedes stale retries instead of colliding with newer
  ones. Subteam leads are also resolved from Org & Access roles now (the old
  lookup only knew the legacy table), and notifications to subteams without a
  lead no longer get rejected by Slack.
- **Clear message when you can't check in.** Uploading without vault write
  permission now says exactly that — "ask your team lead for a role that can
  check in files" — instead of the raw database policy error.
- **Read-only vault users are no longer offered "Add to vault"** (or
  background auto-add attempts) that could only fail.
- **Your role shows up as your role.** The sidebar user pill and vault
  Settings now display your Org & Access role (Engineer, Lead, Executive, …)
  instead of "(no role assigned)" when your access comes from the org tool.
- **Leads can triage bug reports.** The in-app reports viewer (and the
  presence roster) now opens for anyone with role-granting capabilities, and
  the backend permits them to read, re-status, and clean up reports and their
  screenshots — not just legacy global admins.

- **Vault now honors Org & Access roles.** Granting a role that carries the
  vault edit capability (Engineer, Lead, VP, …) now actually grants vault
  check-in/upload rights, and vault view/admin capabilities likewise take
  effect. Previously the vault only consulted its own legacy role table, so
  members granted a role in the Org tool since 2026-06-22 stayed read-only and
  hit "new row violates row-level security policy" when adding or checking in
  files. Legacy vault roles keep working unchanged; capability edits made in
  the role editor apply immediately. (Server-side fix — no app update needed.)

## [5.1.0] - 2026-07-07

### Added

- **Amethyst — an in-app knowledge base.** A new side tab that reads an
  Obsidian-style vault folder of markdown notes and figures, giving the team a
  fast, linked reader for the whole design record, meeting history, and
  reference registers. Point it at a folder and it reads the files live (with a
  filesystem watcher) — nothing is copied or synced, and no sign-in is needed.
  - **Search everything:** full-text with phrase-aware ranking, an "Exact
    phrase" toggle, Car/Subteam/Type filters, results grouped by category and
    subteam, keyboard navigation (↑/↓/Enter), and jump-to-match with a match
    navigator.
  - **Reader:** clickable `[[wikilinks]]`, embedded figures with click-to-zoom,
    callouts, tables, and clickable frontmatter chips / tags / breadcrumbs to
    pivot; an outline that tracks your position, backlinks, hover previews, and
    in-note find (Ctrl+F).
  - **Graph view** of how notes link together, colored by subteam.
  - **Dashboard** with vault stats and composition charts, a command-palette
    quick-switcher (Ctrl+O), and browser-style back / forward navigation.

## [5.0.2] - 2026-07-01

### Added

- Marketplace: a **Refresh** button in the header to re-check for new plugins and
  versions on demand, plus an automatic re-check when the Helios window regains
  focus — so a freshly published plugin or version appears without reloading the app.

## [5.0.1] - 2026-07-01

### Fixed

- Marketplace: installed plugins now execute their code. They were mounted in an
  iframe via `srcDoc`, and an `about:srcdoc` document inherits the host window's
  CSP (`script-src 'self' 'wasm-unsafe-eval'`, no `'unsafe-inline'`), which
  intersected with and blocked every plugin's self-contained inline bundle — the
  plugin rendered its static HTML but ran no JavaScript (blank frame). Plugins now
  load from their own `plugin://<id>` origin (`src=` instead of `srcDoc`), so the
  frame applies the plugin-host's response-header CSP (which allows `'unsafe-inline'`)
  instead of inheriting the host's. `frame-src` widened to allow `plugin:`.

## [5.0.0] - 2026-06-30

### Added

- **Marketplace (v5 plugin platform) — early beta**: a new Marketplace module — the
  first cut of where Helios is heading: first-party "Built-in" apps, bundled
  sandboxed plugins, and a live catalog of installable marketplace plugins, side by
  side. **This is an early beta — try it out and expect rough edges.** Add-ons run in
  a locked-down sandbox (opaque-origin iframe + strict CSP) that cannot reach the DOM,
  the database, the network, or the filesystem on their own; they declare capabilities
  in a manifest (default-deny) and reach the host only through a permission-checked
  broker (`@helios/plugin-sdk`) — user-picked file open/save and private per-plugin
  storage, with a curated high-trust MATLAB engine bridge designed for later.
  Installing fetches the content-addressed bundle, verifies its sha256 **and** an
  Ed25519 signature before unpacking, and shows an explicit consent screen (with an
  unmissable warning before anything high-trust). **CFD** now appears as a first-party
  Built-in app; the **Lap Sim** ships as a bundled sandboxed plugin (extracted from
  CFD and versioned independently of Helios); and **COAST** — the chassis-optimization
  + 3D torsional-FEA tool — is the first plugin published through the real
  sign-and-review pipeline and installable straight from the catalog. Includes an
  Agent Authoring Kit for AI-assisted plugin authors and a `helios-plugin check`
  compliance validator. In-app publishing isn't built yet — the "Upload plugin" button
  is a disabled placeholder, and new plugins are published server-side for now.

### Changed

- **CFD has moved off the main sidebar into the Marketplace** (as a first-party
  Built-in app) — open it from the Marketplace tab. It runs exactly as before.

## [4.5.6] - 2026-06-30

### Added

- **Custom subteam icons**: a subteam's icon can now be set explicitly and persists
  for everyone, instead of only being auto-derived from its name/code. Leads,
  Executives, and Owners click a subteam's icon in the PM sidebar to pick from the
  built-in glyph bank (now expanded with tires, battery/accumulator, electrical,
  cooling, fuel, turbo/intake, exhaust, and manufacturing marks), or reset it back
  to automatic. The ability isn't tied to which subteam you belong to — any
  lead/exec/owner can set any subteam's icon. Picks inherit the subteam color.

## [4.5.5] - 2026-06-29

### Added

- **PM — "Primary only" view toggle**: in any subteam-scoped view (dashboard,
  table, board, calendar, gantt) a new "Primary only" toggle hides tasks where
  the subteam is merely a secondary contributor, leaving just the tasks it
  primarily owns. Off by default and remembered per user, so it never changes
  what teammates see. (Tasks dropped from the owned list still surface as a
  dependency bridge when they connect to the team's work.)
- **Vault — check in from the Checkouts screen**: each of your own checkouts now
  has a "Check in" action on the Checkouts ("Who has what") screen, plus a
  "Check in all mine" button that checks in every file you have checked out in
  the active vault at once — no more hunting each file down folder-by-folder in
  the Browse tree. Freshly-uploaded drafts are published as-is; files you edited
  locally land a new version. (Acts on the active vault, where your local working
  copies live.)

### Changed

- **PM Slack notifications restructured for readability**: each notice now leads
  with who did what and lists field changes one per line (friendly status labels,
  `old → new`), and includes the task **owner and its subteam lead** as recipients
  so leads are notified of changes regardless of who owns the task. (Owner and lead
  are sent to the Slack workflow as user emails — via a new `lead` variable — so the
  workflow can either ping them or show their name.)

## [4.5.4] - 2026-06-24

### Added

- **CFD Lap Sim — vehicle-dynamics (VD) parameter sweeps**: sweep total mass,
  roll-stiffness distribution (RSD), and tire-µ load-sensitivity ("%dropoff")
  across the existing lap sim, with a "lap time vs parameter" plot (baseline
  marked) and a sweep-summary CSV export, reusing the A/B compare workflow. CG
  height is also surfaced as an editor input; CG-height sweeps run on
  lumped-model vehicles, while on roll-config cars they're gated pending the
  quasi-steady-state model work (the current per-axle model keys lateral load
  transfer on roll-arm height, not raw CG).
- **PM — per-project subteam visibility**: a new "Hidden subteams" menu below
  the project subteam sidebar. Project owners/executives can hide subteams that
  aren't relevant to a project for everyone; any member can unhide them for
  themselves or hide additional subteams in their own view. Display-only —
  hidden subteams' tasks stay assigned and remain filterable everywhere else.
- **CFD — sortable Studies list**: sort saved studies by name, kind, status, or
  start date (ascending/descending) via clickable column headers; your choice is
  remembered.

### Fixed

- **Report a bug/feature dialog**: typing in the Details field no longer
  randomly jumps the cursor back to the Title field (it was triggered whenever a
  teammate's presence update re-rendered the app while the dialog was open).

## [4.5.3] - 2026-06-23

### Changed

- **PM task editing**: any **editor (engineer or above)** of a project or subteam
  can now edit every task in their scope — including reassigning its owner and
  changing any other property — not just tasks they personally own or created.
  Admins and leads were already unrestricted; viewers remain read-only.

## [4.5.2] - 2026-06-22

### Changed

- Org admin panel now surfaces the full set of grantable permissions for each
  role and subteam, clearly distinguishing the ones you're allowed to grant from
  the ones you aren't (rather than silently rejecting on save).

### Fixed

- Sign-up: the **subteam picker loads again**. The `list_signup_subteams` lookup
  was addressed to the wrong Postgres schema (`pdm` instead of `public`), so the
  picker errored out with "Could not find the function" and dead-ended sign-up.
- Vault: the sync ledger no longer fails intermittently with "No such file or
  directory" when checking files in. The app-data folder it writes to may not
  exist yet, and the write did not create it; the directory is now ensured first.
  (Harmless before this -- it only meant local-deletion detection lagged a pass --
  but it logged a console warning on check-in.)
- Vault: a corrupted folder parent chain no longer hangs or crashes the whole
  Vault -- folder-path lookups are now cycle-guarded.
- Vault: the vehicle mass KPI no longer double-counts assembly rollup mass
  against its own parts (it was inflated 2x or more).
- CFD: result, lap, and sweep pages no longer white-screen on empty or
  degenerate data; a single-RPM study no longer gets permanently stuck after a
  solver error (which previously blocked all further single-RPM runs that session).
- PM: the bulk "Due date" field no longer clears the due date on every selected
  task when left empty and blurred; task title/description edits no longer write
  to the database on every keystroke (which also destroyed the undo stack); and
  creating a task with dependencies or extra subteams no longer races and
  silently drops them.
- Games: retrying a score submission on a flaky network can no longer create
  duplicate leaderboard rows, and tied scores now share a rank.
- CSV import: semicolon/tab-delimited MoTeC and Link exports, and
  thousands-separated dyno values, now import correctly.
- Many additional correctness, state-reset, and stale-data fixes across CFD,
  Vault, PM, Org, and shared chart widgets. See
  docs/audits/2026-06-22-v4-bug-vault.md.

### Security

- New self-signup accounts are now provisioned as read-only viewers instead of
  global editors, so a newly created account cannot read or modify vault contents
  until an admin promotes it.
- Sign-up is now restricted to approved email domains, enforced server-side
  (seeded with asu.edu and configurable in the database -- not hardcoded in the
  app), so only organization accounts can register.
- Per-vault (subteam-scoped) admins can no longer act as global admins: deleting,
  updating, or listing users org-wide, viewing other vaults' rosters, or granting
  and revoking global roles now requires a true global admin.
- CFD capture loading rejects directory-traversal in job identifiers, confining
  reads to the captures folder.
- CSV exports are now guarded against spreadsheet formula injection.

## [4.5.1] - 2026-06-21

A small follow-up addressing three member feature requests.

### Added

- CFD: **overlay multiple sweep runs** on the result graphs — pick several past
  sweeps from the Overlay strip to compare them on the same charts (e.g. to find
  the best collector length), each with its own color and legend (up to 5).
- CFD: **zoom into result graphs** — click-drag on a chart to zoom the RPM axis;
  a "Reset zoom" button restores the full range.

### Fixed

- Sign-up: the **subteam dropdown now includes every subteam** an admin has added
  in either admin area (e.g. the EV subteams High Voltage / Low Voltage / Battery),
  instead of only the original identity list.

## [4.5.0] - 2026-06-20

This is a focused **Vault audit pass**: a deep bug + feature sweep of the Vault
module (SolidWorks PDM parity) followed by TDD'd fixes. Highlights are several
data-loss / data-integrity fixes in local sync and the recycle bin, plus a fix
for new members landing without vault access.

> Note: the backend (Supabase) migrations below have been applied to the hosted
> database and verified.

### Added

- Vault: **mass / weight-budget dashboard** on the Insights screen — total vehicle
  mass, heaviest parts, mass by subsystem, parts missing mass data, and a delta vs an
  admin-set target mass, all from the Mass already parsed off each part's data card.
- Vault: **impact warning before checking out or deleting a referenced part** — if
  other assemblies currently use the part, you're shown which ones first.
- Vault: **bill of materials (BOM)** for assemblies — open it from a `.sldasm` file's
  details for an indented or flattened parts list with quantity roll-up, total mass,
  and CSV export, built from the stored reference graph.
- Vault: **search by custom property** — type a value like `7075` to find parts by
  their data-card properties, or use `prop:Material=7075` / `prop:Status="In Review"`
  filters, in addition to filename search.
- Vault: **watch files + a notification feed** — star a file to get a bell-icon feed of
  check-ins, check-outs, force-unlocks, deletes and restores on the parts you care
  about. (v1 is per-device; a shared server-side feed is a planned follow-up.)

### Security

- Vault: **closed a cross-vault audit-log leak** — a member of one vault could read
  another vault's activity (check-ins, force-unlocks, role changes) by reading the
  audit log directly. Reads are now limited to your own activity, with full access
  for global admins/owners.
- Vault: **only the owner can edit the owner account** is now enforced on the server
  (not just hidden in the UI), matching the existing owner-delete protection.
- Vault: restoring a file or folder from the recycle bin now requires you to
  **currently** hold edit rights — a member whose role was revoked after deleting can
  no longer restore.
- Vault: deleting a file that someone else has checked out now **records who broke the
  checkout** (force-unlock attribution + audit entry) instead of releasing it silently.

### Fixed

- Vault: **a checked-out file you delete locally and then "undo check-out" is no
  longer soft-deleted for the whole team.** Deletion propagation now re-checks
  that you still hold the lock at the moment of deletion, not just at the start of
  the sync pass.
- Vault: **a file you intentionally deleted no longer silently comes back.** When
  a copy reappears on disk (SOLIDWORKS rewriting it, antivirus restore, a re-copy),
  auto-add is suppressed for a cool-off window instead of re-vaulting it and undoing
  the deletion.
- Vault: **the SOLIDWORKS bridge "get latest" no longer overwrites a writable local
  copy** that may hold unsaved edits — it now skips the same way the drop-import and
  auto-sync paths do.
- Vault: deleting a folder you're currently inside now navigates to the nearest
  still-existing parent folder instead of leaving an empty file list; the breadcrumb
  no longer shows a dead path.
- Vault: a partial multi-file delete now un-checks only the files that were actually
  deleted, keeping the failures selected so you can retry.
- Vault: right-clicking a folder always shows the folder actions (New folder, Delete
  folder) even when other files/folders are selected.
- Vault: bulk check-out and bulk delete now stop immediately when you change the
  selection, switch vaults, or close the panel; an interrupted bulk delete reports
  how many files were removed.
- Vault: **Where Used** now lists only assemblies whose current version actually
  references the part — assemblies that dropped the part in a later check-in no longer
  appear, so archive/rename decisions are safe.
- Vault: a file's property data card now refreshes when another member's check-in
  changes a property value (not only when the number of properties changes).
- Vault: **Who Has What** now shows the holder's name for checkouts held by members
  of other vaults, instead of a raw id.
- Vault: an admin can no longer edit the owner account's profile from the Users &
  roles screen (the owner row is now protected, matching the role/revoke controls).
- Vault: custom properties (Material, Mass, Description, Part Number, …) are now
  extracted from very large assemblies (> 24 MB) instead of occasionally coming back
  empty when SOLIDWORKS stored the property block in the middle of the file.
- Vault: restoring a single file whose folder was deleted now brings the folder back
  too, so the file is browsable again instead of being stranded in a deleted folder.
- Vault: **Where Used / Contains stay correct across delete and restore** — deleting a
  part now marks references to it unresolved, and restoring it re-links them, instead
  of waiting for the next check-in.
- Vault: restoring an old version now points its references at each child's current
  version rather than re-pinning stale ones.
- Vault: assembly references can now be recorded for imported (migrated) versions.
- Vault: Insights no longer count recycle-bin files in its totals, and the "orphans"
  metric now counts genuinely unreferenced parts (it previously missed top-level
  assemblies).
- Vault: **new members now get vault access automatically on sign-up** — every new
  account is granted the baseline Editor role instead of landing with no access at
  all (officers/leads are still promoted to Admin by an admin). Existing members who
  had slipped through without a role were backfilled.
- Vault: the bill of materials no longer merges two different unresolved parts that
  happen to share a filename into one row with a combined quantity.
- Vault: opening a bill of materials that fails to load now shows an error with a
  Retry instead of hanging on "Loading…"; deleting a file shows its where-used impact
  without a blank pause.
- Vault: restoring an old assembly version no longer shows parts that were deleted in
  the meantime as still-present, and restoring a part no longer re-links it under an
  assembly that is itself in the recycle bin.
- Vault: Insights/mass dashboard now resets cleanly when you switch vaults instead of
  briefly showing the previous vault's numbers.
- Internal: audit-log entries carrying an action from a newer server build no longer
  fail to load in older clients.

## [4.4.6] - 2026-06-18

This release is a broad **pre-release polish pass**: a full-repo bug audit followed
by fixes across the Vault, PM, CFD, Games, the SOLIDWORKS add-in, and the Supabase
backend. Highlights are the vault data-loss and PM project-loss fixes.

### Added

- PM: **Creating a new project (season) now works end-to-end.** It saves through the
  secure server path and opens immediately, so the project and any tasks you add
  persist instead of vanishing on the next refresh. Creating a season is admin-only
  and now asks for the car year and a unique car code (e.g. `SDM28`); duplicate codes
  and permission errors are explained instead of failing silently.

### Changed

- PM: co-owner and task-link changes made in other sessions now appear live instead
  of waiting for the next full refresh.
- Vault: the Users & roles screen distinguishes an inherited global role from a
  per-vault override and disables Revoke on inherited rows.
- Vault: the SOLIDWORKS bridge sync backs off after repeated failures and refreshes
  an expired session instead of repeatedly re-pulling the catalog with a dead token.
- CFD: area-under-curve objectives now show the rpm-integrated unit (e.g. `kW·rpm`).
- Vault: "Set revision" returns a clear message when the revision number is already
  used on a file, instead of a raw database error.

### Fixed

- Vault: **auto-sync could silently soft-delete a checked-out file for the whole
  team** when its local copy was momentarily unreadable (e.g. open/locked by
  SOLIDWORKS). A deletion is now propagated only after confirming the file is
  actually gone from disk.
- PM: **a write that failed after you switched projects could overwrite the project
  you switched to.** Optimistic rollbacks are now scoped to the originating project.
- CFD: **importing a CSV with `NaN`/`Inf` corrupted the time axis and poisoned
  channel min/max/sum.** Non-finite times are now rejected and non-finite data cells
  load as null.
- CFD: **engine sweeps and optimizations aborted entirely** when the solver hit an
  unrecoverable state in a single RPM or trial; the failure is now isolated and
  reported as a divergence while the rest of the run continues.
- CFD: charts and readouts that mix channels from different sample-rate groups no
  longer pair data with the wrong time axis (which could show incorrect values).
- PM: co-owners added while creating a task are now saved (previously only the
  primary owner persisted); deleting a subteam no longer leaves an orphaned subsystem
  on re-homed tasks; a background refresh that collided with an in-flight save no
  longer drops the update; task links no longer record the wrong author.
- PM: a task can no longer end up with two primary owners.
- Vault: drag-and-drop import no longer silently overwrites a checked-out (writable)
  working copy; such files are skipped with a clear message.
- Vault: a new file version is no longer briefly hidden when a file update and
  check-in arrive together over realtime.
- Vault: lock-holder names now resolve for per-vault admins (previously
  "Locked by other") in both the Browse tree and Who-has-what; file delete in the
  right-click menu uses per-vault admin rights; Force unlock appears for admins of the
  active vault; a lock change in an unrelated vault no longer forces a full refresh.
- Vault: re-adding a file that was previously sent to the recycle bin now resurrects
  it instead of silently doing nothing; Where-Used no longer shows no results for a
  part whose name once belonged to a since-deleted file.
- Vault/SW: launch-on-login is no longer re-enabled on every startup after you disable
  it; the add-in auto-install prompt is no longer permanently suppressed after a
  declined or failed elevation; stale/truncated add-in and Explorer shell DLLs are now
  refreshed; icon-overlay registration no longer reports false success; a just-
  completed check-out/check-in from the add-in is no longer reverted by a concurrent
  vault refresh.
- CFD: dyno CSV import no longer silently drops rows using European decimal commas
  (skipped rows are counted and a warning shown); the master-report convergence chart
  is no longer drawn out of trial order; line charts no longer drop duplicate-x
  samples non-deterministically; clipboard TSV exports now escape tabs/newlines; a job
  could get stuck showing "running" on a poisoned lock and now records its status.
- Games: the breakout ball no longer tunnels through bricks at high levels; tied
  subteams in the standings now share a rank/medal.
- Org: the role and subteam grant dropdowns no longer offer subteam-only granters
  options the server would reject; the role editor no longer shows a spurious
  "unsaved changes" state from a color-case mismatch.
- Account deletion no longer fails for users who had filed a report or created a task
  link or co-owner record.
- Data: reading an empty Arrow IPC stream returns a graceful error instead of
  crashing; legacy SOLIDWORKS assemblies with UTF-16LE reference paths are now parsed;
  malformed mass-property vectors no longer render nonsense on the data card.
- Misc: lap-time/clock displays no longer show garbage for negative values; a rare
  cursor / view-state / lap-selection update is no longer skipped or double-delivered;
  the XY-plot filter and formula caches no longer grow unbounded.

### Security

- RBAC: fixed a privilege over-grant where signups whose subteam didn't match a known
  team received org-wide engineer/lead capabilities; they are now confined to an
  "Unknown" subteam, and subteam-scoped grants can no longer be saved without a
  subteam.
- Vault: checking in or cancelling a checkout is no longer allowed after a user's
  editor role is revoked while they hold the lock; a user can no longer move their own
  lock onto a file in a vault they cannot edit.
- Vault/SW: add-in registry installs now use a per-launch private temp directory,
  hardening the elevated import against local tampering; "reveal in Explorer" and the
  read-only file toggle reject malformed/symlinked paths.
- Database: enabled row-level security (default-deny) and revoked client grants on
  internal `pm` backup snapshot tables (`tasks_project_move_backup`,
  `deleted_tasks_backup`, `tasks_status_backup`) that were exposed in an API-visible
  schema without RLS, resolving the two Supabase Security Advisor errors.

## [4.4.5] - 2026-06-18

### Fixed

- PM: fixed a crash that could make the Project Management module fail to load
  ("Spread syntax requires ...iterable") right after updating, when a workspace
  cached by an older version was missing a newer field. Hydration is now
  crash-proof and stale caches refresh automatically.
- Games: the **subteam standings** no longer let one game decide everything. Raw
  scores were summed across games, so 2048 (scores in the thousands) buried Snake,
  Breakout, and Flappy (scores in the tens). Subteams are now scored
  **Grand Prix style** -- ranked within each game for placement points
  (10/8/6/5/...) that sum across games, so every game counts equally.

## [4.4.3] - 2026-06-18

### Added

- PM: tasks can now have **multiple owners**. The Owner field still sets the
  primary owner; a new "Co-owners" control on the task detail panel adds other
  members who can also edit the task. (Requested in-app by Alex Rumer.)
- PM: attach **hyperlinks** to a task. A new "Links" section on the task detail
  panel lets you add labeled URLs (docs, drawings, specs) that open in your
  browser. (Requested in-app by Jaxson Whitelaw.)

## [4.4.2] - 2026-06-17

### Added
- **Admin section (new, owner/admin only).** A top-level **Admin** area that
  manages access across both Vault and PM from one place:
  - **People & Roles** — assign each person a role; edit their name and subteam.
    Roles are a clean rank-per-subteam model — Engineer / Lead / VP within a
    subteam, plus org-wide **Executive** and specific officer titles (President,
    COO, CFO, Chief Engineer). All grants are guarded server-side (you can only
    grant what you hold; the Owner can't be removed).
  - **Org Structure** — map which subteams build which car and tag each car
    **IC** or **EV**; create and remove subteams (a subteam in two cars is
    "shared").
  - **Role Editor** — create and edit roles and exactly which capabilities each
    one grants — no more hard-coded permissions.
- **Google Calendar on the PM calendar.** The team Google Calendar is pulled in
  automatically (refreshed hourly), with recurring meetings expanded to every
  date and cancellations/changes reflected. Toggle the layer on/off (your choice
  is remembered) and click any event for full details.
- **Dashboard photos.** A Photos widget lets a subteam (or the all-team)
  dashboard carry images — editable by that subteam's lead+ (or an executive),
  visible to everyone.
- **Dashboard "Date histogram" widget.** A new customizable dashboard widget
  charts your tasks bucketed across time by their **start** or **due** date —
  from the earliest to the latest — so you can see when work is scheduled to
  ramp. Buckets auto-widen (daily → weekly → monthly) as the span grows, or you
  can pin a fixed size, and filter to all / open / due-window tasks.

### Changed
- **User & role management moved out of the Vault** into the new **Admin**
  section, since roles now govern both Vault and PM.

### Fixed
- **Shared subsystems can now be picked on tasks.** A subsystem shared into a
  subteam (in the Subsystem Editor) was missing from the Subsystem dropdown when
  creating or editing a task under that subteam, so only the owning subteam could
  use it — defeating the point of sharing. The create dialog and task detail
  panel now list shared subsystems alongside owned ones.

## [4.4.1] - 2026-06-17

### Added
- Admins can leave a **resolution note** on a bug/feature report. The note shows
  in the reports viewer and is visible to the person who filed the report.

### Fixed
- **Project tasks: edits that silently reverted now save — or tell you why.**
  Changing a task's priority, owner, status, or other fields could look like it
  worked and then revert after switching tabs or restarting, whenever you didn't
  have permission to edit that task. PM now rolls the change back and shows the
  real reason (e.g. "engineers can only edit tasks they own or created") instead
  of silently dropping it. This covers all of PM — tasks, milestones, vendors,
  calendar events, subteams, subsystems, and dependencies — not just tasks.
- **You can now edit tasks you created.** New tasks record their creator, so
  whoever makes a task can edit it even if it isn't assigned to them. (Tasks
  created before this update keep their existing owner/lead/admin edit rules.)
- Task detail fields are now **read-only with an explanation** when you can't
  edit that task, instead of showing editable controls whose changes wouldn't
  save.

## [4.4.0] - 2026-06-16

### Added
- In-app **Bug / Feature report** tool — a "Report a bug" button in the sidebar
  that captures a diagnostics snapshot (recent breadcrumbs + last error) and an
  optional screenshot, plus an admin-only **reports viewer** with status triage
  (new → triaged → fixed).
- Reports viewer is **color-coded** by kind (bug / feature), severity, and
  status, and shows the reporter's **name, subteam, and email**.
- Admins can **delete reports** (and their screenshot attachments) from the
  viewer.

### Changed
- **App-wide visual refresh.** The intended typography (Inter for UI, JetBrains
  Mono for numbers) is now actually bundled and renders identically on every
  machine instead of falling back to OS fonts. The primary module rail and the
  per-module sidebars (Vault/CFD/PM) now share one icon-row design language with
  a consistent grey rail and gold-tint active state. Added consistent focus
  rings, panel elevation, modal entrance motion (all reduce-motion aware), global
  scrollbars, branded empty states, and a refined loading screen.
- Renamed the Vault "Who has what" screen to **"Checkouts"**.
- Report screenshots are now attached by **uploading an image file** rather than
  the in-app window capture.

### Removed
- The native window-capture command (`capture_app_screenshot`) and its `xcap`
  dependency, which never reliably captured the report screenshot.

### Fixed
- Vault PDM cutover hardening: bulk check-in/out/cancel now keep the read-only
  bit correct, file create+lock no longer reports false success, a stale move
  ledger entry can no longer soft-delete a live file, and per-vault role/admin
  affordances are scoped correctly.
