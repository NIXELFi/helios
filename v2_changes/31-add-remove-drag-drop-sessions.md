# 31 · user-loaded sessions (add / remove / drag-drop) · v2.5.1

Helios can now load arbitrary CSV files at runtime in addition to the
bundled samples. Three entry points:

- **`+`** in the Sessions panel header → native file picker (multi-select).
- **Drag-and-drop** any `.csv` onto the app window — the OS-level webview
  drop is wired through `useFileDrop`. `.helios` workspace bundles continue
  to flow through `useFileOpener` so a single drop only triggers one
  consumer.
- **`×`** on a session row (visible on hover) removes the session from the
  current run. Bundled samples reappear on next launch; user-loaded files
  stay on disk.

## Link ECU CSV support

Loader now strips the Link `"Name","ECU Internal Datalog…"` preamble in
addition to MoTeC's. Same shape — preamble + header + units + blank +
data — but the trigger and the metadata block size differ. Pattern-keyed
so non-Link files pass through untouched. Test fixture at
`fixtures/good/link_minimal.csv`.

## How user files are persisted

- Session id = `user:` + djb2(absolutePath) so reloading the same file
  gets the same id, which preserves the per-session lap detection config
  saved in `localStorage helios.lap-config.v1`.
- Session label = filename without extension.
- Session color = next slot in `SESSION_PALETTE` after the existing list.
- The actual data is **not** persisted across app restart — only the lap
  config keyed off the path. The user re-adds files (or drops them) on
  next launch.

## Defended against

- Files with extensions Helios can't yet load (`.llgx`, `.ld`, `.ldx`)
  surface a single per-batch error dialog explaining the limitation
  rather than failing silently or trying to parse them.
- `.helios` workspace bundles dropped onto the app window keep flowing to
  `useFileOpener` (workspace import) instead of being treated as data.
- Reloading a file with the same path replaces the existing session
  rather than duplicating it.
- Removing the current primary session promotes the next visible session
  to primary; lap selections pointing at the removed session are pruned.

## Files

New:
- `apps/desktop/src/lib/load-user-session.ts`
- `apps/desktop/src/lib/use-file-drop.ts`
- `fixtures/good/link_minimal.csv`

Updated:
- `crates/helios-csv/src/load.rs` — `preprocess_link_if_needed` + test
- `apps/desktop/src/App.tsx` — handlers + drop wiring + delete confirm
- `apps/desktop/src/components/SessionPanel.tsx` — `+` and `×` buttons,
  hover-revealed remove, footer hint
