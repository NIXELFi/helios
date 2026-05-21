# 34 · in-app Help & Wiki + full docs/wiki/ · v3.2.2

A complete user + developer wiki, plus a Help menu inside the app that
renders the same content. Until now, the only place to learn what Helios
could do was to read source — every onboarding conversation went through
someone who already knew the codebase. This makes the documentation
first-class.

## What ships

### `docs/wiki/` (12 pages, ~1,940 lines)

- `README.md` — Home. Opens with what Helios is for (Logs + Vault as
  co-equal halves of the product) and a typical-workflow cookbook
  ("I just got data off the car", "I want to compare two sessions",
  "I want to compare laps within a session", "we need everyone on the
  same files", "I built a dashboard worth sharing", "I want to take
  this further with code").
- `01-getting-started.md` — install, **load your own data** (drag-drop,
  ＋, ⌘O), session model, first five things to try, Vault basics, share
  bundles, persistence layer, plus a footnote section explaining that
  the bundled samples are first-launch scaffolding, not the product.
- `02-app-tour.md` — every region of the window, every header button,
  every modal, the loading screen, theme/a11y baseline.
- `03-workspaces-and-tiles.md` — grid model, CRUD, edit mode, the
  `.helios` share-bundle format and import flow.
- `04-widgets-reference.md` — every one of the 18 widgets with its
  config options, scrub/overlay/distance-mode capabilities, and the
  cross-cutting capability matrix.
- `05-channels-and-data.md` — canonical registry, the three CSV
  flavors (MoTeC / Link / plain), the three-layer smart resolver,
  per-session source overrides, rate groups, the GPS micro-degree
  decode.
- `06-math-channels.md` — full expression grammar, every scalar
  function, every time-aware vector op, palette UI, compile/apply
  pipeline, ten worked example expressions.
- `07-laps-and-analysis.md` — detection modes, the global
  LapSelectionEmitter, distance mode, the footer compare strip.
- `08-keyboard-and-commands.md` — full hotkey table, ⌘K palette
  registry, F1 (Help), accessibility passes already shipped.
- `09-modules-vault-logs.md` — Vault deep-dive (screens, custom hooks,
  data model, auth, palette unification with Logs).
- `10-developer-guide.md` — toolchain, dev workflow, test runners,
  Tauri config, CI matrix, versioning script, repo layout.
- `11-changelog-and-history.md` — version timeline + per-entry digest
  of every v2_changes file + cumulative feature inventory.

### In-app Help & Wiki modal

- **Header `Help` button**, next to ⌘K.
- **F1** hotkey, universal (works from form fields too).
- **⌘K palette actions**: `Open Help & Wiki` plus six page-specific
  deep links (`Help: Widgets reference`, `Help: Math channels`, etc.).
- Modal: sidebar nav with search + back history; rendered markdown
  with prose typography; wiki-internal links navigate inside the
  modal; external `https://` links open in the system browser;
  footer has an "Edit on GitHub" link pointing at the current page.

### How it stays in sync

`docs/wiki/*.md` is the source of truth. The modal uses
`import.meta.glob("../../../../docs/wiki/*.md", { eager, raw })` to
read the markdown at build time, so a wiki edit becomes a help-menu
edit on the next launch. No copy/paste, no two-place updates.

`vite.config.ts` extends `server.fs.allow` to whitelist `docs/wiki/`
in dev mode so the dev server can read outside the package root.

### Markdown renderer

`src/help/markdown.ts` — dependency-free, ~200 lines. Handles:

- ATX headings with auto-generated anchor ids
- Paragraphs (multi-line)
- Fenced code blocks with language tag
- Inline code (with HTML-escape inside)
- `**bold**`, `*italic*`
- Wiki-internal, external, and repo-relative links (each routed
  differently in the modal)
- Unordered + ordered lists
- Blockquotes
- Horizontal rules
- Pipe tables with column alignment
- Safe HTML escape on everything else

12 unit tests in `tests/help-markdown.test.ts` cover all of the above
plus the HTML-escape safety case.

### Side updates

- `v2_changes/README.md` index was stale at entry 28; extended to 33
  (and now 34).
- `scripts/capture-wiki-screenshots.ps1` — interactive PowerShell
  helper that walks through the 14 wiki screenshots, naming each file
  correctly so cropping is the only manual step.
- `ShortcutsOverlay` gains an F1 row.
- `styles.css` gains a `.helios-wiki-prose` typography block scoped
  to the help modal.

## What's NOT in this commit

- **Screenshots.** The wiki references 14 screenshots in `images/`;
  the capture script is ready but the screenshots themselves haven't
  been taken. Driving a Tauri window from a sandboxed shell isn't
  reliable, so this is best done by a human on a real machine running
  `pwsh -File scripts\capture-wiki-screenshots.ps1`.
- **Focus trap inside the Help modal.** Consistent with other modals
  in the app — focus-trap-on-modal is on the UI follow-ups list
  (T1.10a). Esc still closes correctly.

## Files

```
docs/wiki/                                       (NEW, 12 pages + images/README)
apps/desktop/src/help/HelpModal.tsx              (NEW)
apps/desktop/src/help/markdown.ts                (NEW)
apps/desktop/src/help/pages.ts                   (NEW)
apps/desktop/tests/help-markdown.test.ts         (NEW, 12 tests pass)
apps/desktop/src/App.tsx                         (Help state + button + F1 + 7 palette actions)
apps/desktop/src/components/ShortcutsOverlay.tsx (F1 row)
apps/desktop/src/styles.css                      (.helios-wiki-prose)
apps/desktop/vite.config.ts                      (server.fs.allow for docs/wiki/)
v2_changes/README.md                             (index extended to 34)
scripts/capture-wiki-screenshots.ps1             (NEW)
```
