# Helios UI Audit — Follow-ups

Captures everything from the 2026-05-12/13 audit that hasn't shipped yet, with concrete pointers for picking up. Items already done are listed at the bottom for cross-reference, in case you want to see context.

Audit origin: 6 parallel agents reviewing visual design, IA, widget catalog, workflow gaps, states/perf/a11y, and innovation; see the conversation transcript for the original findings (the full reports are in agent output files under `/private/tmp/.../tasks/*.output`).

Conventions in this doc:
- **Effort** — S (≤½ day), M (½–2 days), L (>2 days), XL (multi-week)
- **Impact** — H (most users notice immediately), M (regular users notice), L (power users / a11y / future-proofing)

---

## Tier 1 — Outstanding (would-ship-next-sprint quality)

### T1.4 — Token consolidation in Logs (raw hex → semantic tokens)
**Status:** PARTIAL. Vault is fully migrated to `helios-base/panel/line/text/dim` + `asu-gold`. Logs side still uses ~200+ raw `bg-[#…]` / `text-[#…]` / `border-[#…]` literals in `apps/desktop/src/**` and `packages/widgets/src/**`.

**Effort:** S–M (sed codemod, similar to the Vault pass already done in commit-equivalent work — see `apps/desktop/src/modules/vault/**` history)
**Impact:** L (visual feels the same; future maintainability is the win)

**Concrete fix:**
1. Decide whether to add semantic `danger`/`warn`/`success`/`info` tokens to `apps/desktop/tailwind.config.ts`. Recommend yes.
2. Codemod `bg-[#0E0E10]` → `bg-helios-base`, `bg-[#16171B]` → `bg-helios-panel`, `border-[#2A2C32]` → `border-helios-line`, `text-[#D8DCE2]` → `text-helios-text`, `text-[#9097A0]` → `text-helios-dim`, `text-[#FFC627]` → `text-asu-gold`.
3. The 5 different reds (`#EF5350`, `#D32F2F`, `red-500`, `red-400`, etc.) → one `text-danger` etc.
4. Add a stylelint rule banning raw hex in `widgets/src/**` to prevent regression.

---

### T1.7 — "Open in Logs" handoff from Vault
**Status:** NOT DONE. Vault is bolted on; opening a file requires manually downloading then drag-dropping into Logs. The audit called this the #1 IA seam.

**Effort:** M
**Impact:** H

**Concrete fix:**
1. Lift `active` / `setActive` from `apps/desktop/src/Shell.tsx:20` into a context.
2. Add `RowActions.tsx`-level "Open in Logs" action that: downloads if needed (`useDownloadVersion`) → calls `handleAddSessionFiles` (currently App-internal — also lift to context).
3. When Logs opens a file present in the Vault, show a "tracked in Vault · v3" badge in `SessionPanel` rows (cross-reference by local path).

---

### T1.8 — Replace emoji icons with lucide-react
**Status:** NOT DONE. `FileTable.tsx` and a few other places use `🔒`, `●`, `↓`, `✓` etc. Apple emoji on macOS, Segoe on Windows — different shapes per OS for *critical* lock indicators.

**Effort:** S (lucide-react is tree-shakeable, ~1KB/icon)
**Impact:** M

**Concrete fix:** `pnpm add -F @helios/desktop lucide-react`. Replace `🔒` → `<Lock size={12} />`, `●` → `<Circle size={8} fill="currentColor" />`, etc. The Vault row state map at `apps/desktop/src/modules/vault/components/FileTable.tsx:74-120` is the single biggest win.

---

### T1.10 — A11y completion
**Status:** PARTIAL. `role="dialog" aria-modal="true"` is set on every modal (UpdateModal, AddTileModal, ChannelsModal, MathChannelsModal, LapConfigDialog, ConfirmDialog, CommandPalette, ShortcutsOverlay). `prefers-reduced-motion` honored. Body text contrast bumped to AA. Two pieces still missing:

#### T1.10a — Focus traps in modals
**Status:** NOT DONE. Tab still escapes into the dimmed background from inside any modal.

**Effort:** S
**Impact:** M (a11y; small UX improvement for keyboard users)

**Concrete fix:** Add `useFocusTrap(open, ref)` hook in `apps/desktop/src/components/`. On open: query all focusable descendants, focus the first; on Tab/Shift+Tab at the boundary, wrap to the other end; on close, restore focus to the trigger element. Wrap into a single `<Modal>` primitive and route the 5 existing modals through it — also DRYs the duplicated `bg-black/60 flex items-center justify-center z-50` outer div.

#### T1.10b — Text alternatives for canvas charts
**Status:** NOT DONE. Every uPlot / gps-track / fft canvas is an anonymous bitmap to screen readers.

**Effort:** S
**Impact:** L

**Concrete fix:** Sibling `<span className="sr-only">` per widget describing "Strip chart, 3 channels: RPM 0–14000, throttle 0–100…". Updated on config change. Could live in a shared `lib/canvas-a11y.tsx` helper.

---

## Tier 2 — Outstanding (next-quarter quality)

### T2.1 — Inspector right-rail replaces modal stack
**Status:** NOT DONE. `ChannelsModal` (273 lines), `MathChannelsModal` (536 lines), `AddTileModal`, `LapConfigDialog` (282 lines), `ConfigPanel` all compete for the same heavy-dialog pattern. MoTeC i2 puts these in a single dockable left/right pane.

**Effort:** L
**Impact:** H — fundamentally cleaner IA, removes 4 modal dismiss/reopen loops per analysis session

**Concrete fix:**
1. New `apps/desktop/src/components/Inspector.tsx` — right rail (~340px wide), tabs `Channels | Math | Tile | Laps`.
2. Migrate `ChannelsModal` → `<ChannelsTab inside Inspector>` (keep state in Inspector, drop modal wrapper).
3. Same for Math, AddTile (becomes "Tiles" tab with picker palette when in edit mode), LapConfig.
4. Keep workspace tabs visible in edit mode (today they vanish at `App.tsx:706` — `editMode` clears the tab bar).
5. Inspector stays docked but is collapsible via a sliver.

---

### T2.2c — Crosshair-readout widget
**Status:** NOT DONE (partially mooted: strip-chart corner pills now show live per-(session × channel) values).

**Effort:** S
**Impact:** M

**Concrete fix:** New `packages/widgets/src/crosshair-readout/` widget — config = `channelIds: string[]`, render = one row per (session × channel) with value + Δ-to-Ref column. Reuses `sampleAt`. Pairs with Ref-lap context to show "main lap: 9420 RPM @ cursor · ref lap: 7100 · Δ −2320."

### T2.2d — Driver-inputs stack preset
**Status:** NOT DONE. Buildable today by configuring a strip-chart with steering/throttle/brake/clutch.

**Effort:** S (this is a workspace preset, not a new widget)
**Impact:** M

**Concrete fix:** Ship a `driver-inputs` strip-chart preset (locked Y axes per input type). Bundle it into the lap-analysis workspace via a v5→v6 migration, similar to how `sector_table` and `lap_delta` were added.

### T2.2e — Engine map heatmap
**Status:** NOT DONE. Different shape from `xy_plot` scatter — needs proper 2-D binning (RPM × throttle, color = AFR/IAT/CHT).

**Effort:** M (new widget; 2-D bin computation is straightforward)
**Impact:** M (high for tuning, lower for race analysis)

### T2.2f — Replay / transport widget
**Status:** NOT DONE. Header already has a `PlaybackControls` component embedded but it's small.

**Effort:** S
**Impact:** M

**Concrete fix:** Move the header playback controls into a proper tile-friendly widget, plus add loop start/end markers. Already has the cursor emitter + RAF tick infrastructure.

---

### T2.3 — Split Sessions panel into Sessions + Laps rails (cross-session laps)
**Status:** PARTIAL. M/R/O buttons exist per lap row, fixing the worst discoverability issue. But the lap rail still only shows the *primary's* laps — to overlay laps from a different session, the user has to promote primary first.

**Effort:** M
**Impact:** H (the entire "compare A's best to B's best" workflow)

**Concrete fix:** In `apps/desktop/src/components/SessionPanel.tsx`, the bottom rail should list **all visible sessions' laps**, grouped by session with a session-color header. Each row gets the same M/R/O buttons but the LapRef carries the source session's id. The current `selectLap` already supports this — only the rendering changes.

---

### T2.5 — MoTeC header metadata + recursive folder watch
**Status:** NOT DONE. MoTeC CSV exports have header rows above the column row containing event/driver/vehicle/date metadata — currently discarded by `crates/helios-csv`. `useLocalFolderScan.ts` in the Vault has full recursive folder-watch with `watchImmediate`, interval rescan, focus rescan — not wired to the session list.

**Effort:** M
**Impact:** H

**Concrete fix:**
1. In `crates/helios-csv/src/`, parse the leading rows (until the first row that "looks like" a column header). Stash as `SessionMetadata { event, driver, vehicle, date }` and expose via `ChannelStore.metadata()`.
2. Bubble up to `LoadedSession.metadata?: SessionMetadata`. Surface in `SessionPanel` row as a hover-card or expand-row.
3. In Logs, add a "Watch folder…" Sessions-panel action that reuses `useLocalFolderScan` and auto-adds new CSVs as they appear.

---

### T2.6 — Labels on persistent annotations (datums)
**Status:** PARTIAL. Datums (vertical markers) now persist per primary session. They're still unlabeled.

**Effort:** M
**Impact:** H

**Concrete fix:**
1. Change `view-state.ts` `datums: number[]` → `datums: { timeUs: number; label?: string; color?: string; author?: string }[]`.
2. On shift-click drop, inline a tiny editable label input near the new datum.
3. The strip-chart datum rendering at `drawDatums()` already supports labels (currently shows formatted time); swap to user label when present.
4. Persistence schema in `app-state.ts` extends the `datums?: number[]` field accordingly (bump v1 to v2 or use shape-tolerant validation).

---

### T2.7 — Workspace screenshot / PDF export
**Status:** NOT DONE. The audit ranked this in top 5 ROI items: "send me a screenshot of that" is the #1 cross-engineer interaction.

**Effort:** M
**Impact:** H

**Concrete approaches:**
1. **Quick + dirty:** Trigger `window.print()` with a print stylesheet — gives a PDF via the OS print dialog. Zero deps.
2. **Better:** Add `html-to-image` (~30KB minified, no Node deps) and render the current workspace's `<main>` to a PNG, then `save_file_dialog` via Tauri to write it. ~50 lines of TS plus a Tauri write-file capability.
3. **Best:** A Tauri Rust command that screenshots the webview natively via the `xcap` or `screenshots` crate — sharper output, handles canvas elements better than DOM walkers. ~half day of work plus capability config.

Recommend #2 for shipping speed; #3 if image fidelity matters.

---

### T2.8 — Performance: downsampling + Web Worker boundary
**Status:** NOT DONE. The audit identified this as the biggest production-readiness risk. No LTTB / MinMax downsampling anywhere. Arrow → Float64Array conversion happens on the main thread in `packages/store/src/load.ts:37-46`. `strip-chart/render.tsx:71-84`'s `buildTimeData` builds a JS Set over every sample of every overlay on every slice change. `Tile` re-slices every session on every parent render with no memoization.

**Effort:** L
**Impact:** H on large data (>1M rows); invisible otherwise

**Concrete fix list:**
1. **LTTB downsampling** in `packages/store/src/slice.ts` keyed on `pixelsWide`. Drop 1M-point series to <10K with no visual loss above 1080px. uPlot consumes the smaller arrays directly.
2. **Move CSV → typed-array decoding to a Web Worker.** The Rust crates are already efficient; the JS-side `.get()` loop in `load.ts` is the main-thread killer. Worker boundary keeps the splash alive on big files.
3. **Memoize `Tile.sliceFor(session.id, channels, range)` at App level** so two tiles requesting the same channels share one slice.
4. **Throttle cursor emission to display refresh** by frame-token, or move ticking inside widgets so React's commit phase isn't hit per frame from `App.tsx:998-1015`.
5. **Pause the RAF loop and viewState subscriptions when `active !== "logs"`** in `Shell.tsx` — Vault doesn't need them but they keep running.

---

### T2.9 — Per-file load resilience on cold boot
**Status:** NOT DONE. Today one corrupt bundled CSV bricks the loading screen — `App.tsx`'s `loadAllSessions(...).catch(setError)` is all-or-nothing.

**Effort:** S
**Impact:** M

**Concrete fix:** Per-file try/catch in `loadAllSessions` (`apps/desktop/src/lib/load-sample.ts`), accumulate failures into `LoadProgress.failures`, render "loaded 3 of 4, [Show details] [Continue]" panel. Same pattern as `handleAddSessionFiles` already uses for user-opened files.

---

### T2.10 — Real first-run experience
**Status:** NOT DONE. App always loads bundled samples; no "drop your first CSV here" panel, no welcome tour.

**Effort:** S
**Impact:** M (one-time only, but it's the moment the user decides if Helios is worth their time)

**Concrete fix:** When `sessions.length === 0` after the boot useEffect (or only the bundled samples are loaded and user has never added one), show a `FirstRunPane` centered hero with three buckets: "Drop a file", "Open from Vault", "Try the samples". Stop auto-loading samples unconditionally. Persist `firstRunSeen: boolean` in `app-state.ts`.

---

## Tier 3 — Innovation backlog (months, not weeks)

These are the original 14 outside-the-box bets ranked impact-per-effort. Bookmarking for when there's space.

### T3.1 — "Why was I slow in T3?" Claude lap-delta narration
**Effort:** M · **Impact:** H · **Moat:** **★** None of MoTeC/AiM/Cosworth/Pi has native LLM tool use against a typed channel registry.

Sketch: button on Lap Panel → downsample (Main lap, Ref lap) to ~50Hz → ship as a structured tool-call to Claude with a system prompt that knows `docs/channels.yaml` → output ranked plain-English findings with timestamps that scrub the cursor when clicked. New `packages/lib/src/lap-diff.ts` + widget `packages/widgets/src/lap-narrative`. Anthropic API client via `@anthropic-ai/sdk`.

### T3.2 — Reference-Ghost / theoretical-optimal lap (full)
**Status:** PARTIAL. The sector_table widget's "opt" row gives sum-of-best-sectors. A *trace* version is missing — stitch fastest minisectors into a synthetic lap rendered alongside real laps in the channel-store. **Effort:** M · **Impact:** H

Concrete: 5m grid along distance, per micro-segment pick the fastest minisector across all loaded sessions, stitch and materialize as a synthetic session in the channel store. Multi-session overlay infrastructure already supports it.

### T3.3 — Video sync with audio-RPM autoalign
**Effort:** L · **Impact:** H · **Moat:** **★** Audio-RPM autoalign is genuinely hard; competitors hard-sync to GPS time only.

Drop an MP4 next to a CSV → cross-correlate audio-RPM peaks with `engine.rpm` peaks (~30s of FFT work reusing `fft.ts`). New floating video tile widget tied to the cursor emitter. New `crates/helios-video` Rust sidecar for ffmpeg-rs decoding.

### T3.4 — Live phone-tether mode (`crates/helios-live`)
**Effort:** L · **Impact:** H for FSAE teams

Companion app reads OBD-II/CAN over Bluetooth from car → mDNS over paddock wifi → Tauri shell ingests as streaming session. Every existing widget animates live. The math-expr engine you already have means real-time alarms ("oil_temp > 110") fall out for free.

### T3.5 — Alarm-engine v2 + Apple Watch / pit-board push
**Effort:** M · **Impact:** M (depends on T3.4 for real value)

Marries existing `alarm-panel` widget primitives to APNs notification target via a Supabase Edge Function. Watch buzzes for "brake temp > 450" while driver is on track.

### T3.6 — Setup-sheet ↔ run correlation workspace
**Effort:** M · **Impact:** H

New Vault content kind: `setup.json` (springs, ARBs, ride heights, tire P). New "Setup Lab" workspace — pick two setups, channel-store overlays their best laps, regression view shows which channel deltas correlate. "Stiffer rear ARB → mid-corner yaw rate fell 8%, tire ΔT grew 14°C."

### T3.7 — Plugin / extension surface
**Effort:** M · **Impact:** M (becomes H once a marketplace forms)

`helios.toml` plugin manifest contributing new math functions (Rust→WASM via wasmtime) and new widget types (React UMD bundles). Vault becomes a recipe marketplace. `widgetRegistry` and `parseExpr` are already 80% extensible.

### T3.8 — Driver coaching audio cues
**Effort:** S→M · **Impact:** M

Reference lap → throttle/brake/steering curves → TTS spoken cues ("brake earlier", "open throttle now") → MP3 timestamped to GPS position. Plays in cockpit via paired phone.

### T3.9 — Sensor-health anomaly detection
**Effort:** M · **Impact:** M

`crates/helios-anomaly` running isolation-forest or robust-z across the trailing N sessions per channel. Flags: thermistor dropouts, GPS multipath, slow-degrading wheel-speed sensors, growing brake-fade signature. Surface via top-bar pill.

### T3.10 — Multi-driver review threads in Vault ("Loom for telemetry")
**Effort:** M · **Impact:** H · **Moat:** **★** Vault locks/versions/realtime infra is debt competitors won't repay.

Right-click any cursor position → "Comment" → drops a pin at `(session, time_us)` with threaded comments and mention syntax. Supabase realtime (already wired via `useVaultRealtime.ts`) makes it live.

### T3.11 — Sim integration (iRacing/AC/RF2)
**Effort:** M · **Impact:** M

UDP listener for iRacing's telemetry API; normalize channel names through `docs/channels.yaml`. Same widget stack, real and sim data live in one continuum.

### T3.12 — Public anonymized lap sharing — "Strava for race cars"
**Effort:** M · **Impact:** L now, H if it goes viral

Opt-in: publish a lap from Vault (stripped of identifying metadata). Leaderboard per circuit with ghost overlay.

### T3.13 — Voice control / hands-free trackside
**Effort:** S · **Impact:** L (delightful, niche)

"Helios, show me oil temp last run" via Whisper.cpp local Tauri sidecar. Intent grammar in `packages/lib/src/voice.ts`.

### T3.14 — PDM-aware electrical workspace
**Effort:** S · **Impact:** M for FSAE / club racing teams running PDMs

`crates/pdm-*` already exists. Wire PDM channel outputs into the channel store; new "Electrical" workspace preset with current/voltage overlays + wiring-diagram tile. You're the only DAQ tool that also parses PDM firmware blobs.

---

## What's already shipped (cross-reference, summary form)

Everything in the audit's headline list except the items above. Highlights:

- **Δt-vs-distance trace widget** with live cursor sync, final-delta header pill, color-coded (Main slower = red, Main faster = green)
- **Sector-splits widget** with purple-best highlighting, theoretical-opt row, configurable sector count
- **⌘K command palette** with workspace switch, session swap, lap M/R selection, system actions (open channels/math/add tile/edit/zoom/datums/shortcuts), per-lap "set lap N as Main/Ref"
- **Keyboard shortcuts**: ⌘1..9 workspace, ⌘E edit, ⌘O open, ⌘K palette, `[`/`]` lap step, `M`/`R` set lap at cursor, `?` shortcuts overlay, Space play/pause (already existed)
- **Strip-chart improvements**: live cursor readouts per (session × channel), distance-mode pointer scrub, distance-mode cursor crosshair, channel-collapse-beyond-2-groups fix
- **Persistence**: last workspace, recent user CSVs (silent re-load on boot), cursor + zoom + datums per primary session, manual lap selection
- **Bar-gauge / engine-bar** peak-hold drift fixed (resets on session/range/channel change)
- **Histogram** Y-axis with gridlines and count labels
- **Vault palette unified** with Logs (17 files codemodded from `zinc-*` shadcn → Helios tokens)
- **Tauri title-bar overlay** with inset traffic lights, header doubles as drag region
- **A11y**: `role="dialog" aria-modal="true"` on every modal, `prefers-reduced-motion` honored, body text contrast bumped to WCAG AA (`#7B8088` → `#9097A0`)
- **Workspace migrations** chain: v1→v2 colors, v2→v3 inserts lap-delta tile, v3→v4 seeds lap-analysis if missing, v4→v5 inserts sector-table tile
- **M / R / O buttons** per lap row in Sessions panel (replaces tooltip-only modifier clicks)
- **Lap-compare footer segment** — `Main 1:42.30 · Ref 1:43.70 · Δ +1.40s` whenever both selected
- **`?` keyboard shortcuts overlay**
- **LoadingScreen** version string now dynamic (was hardcoded `v2.1`)
- **359 tests passing** across `@helios/widgets` (88) and `@helios/desktop` (271); typechecks clean throughout

---

## How to pick this back up

1. Pick from Tier 1 first — those were sized for "next sprint."
2. Tier 2 items have explicit "Concrete fix" notes — they're scoped enough to start without re-thinking design.
3. Tier 3 ideas need a brainstorming/spec pass before implementation. Treat them as opportunities, not tickets.
4. When adding a feature, follow the existing patterns: pure compute in a `compute.ts`, renderer separate, config-editor minimal, registry entry, mount test, optional workspace-storage migration to expose by default. The `lap-delta` and `sector-table` widgets are the canonical templates.
5. Workspace-storage migrations are sticky — once you bump `CURRENT_VERSION` and ship, you can't easily roll back. The chain so far is v1→v5; bump only when a layout change matters enough to retroactively patch every user.
