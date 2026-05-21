# Wiki screenshots

This folder holds the screenshots referenced in the wiki pages.

## To (re)capture them

1. Start the app: `pnpm dev` from the repo root.
2. In a second terminal: `pwsh -File scripts\capture-wiki-screenshots.ps1`.
3. The script walks you through each shot — set up the state, press Enter, the script takes the capture and names the file.
4. Crop the screenshots to the Helios window if needed.
5. Commit the updates here.

The script saves PNGs with these filenames (referenced in the wiki):

| File | What it should show |
|---|---|
| `overview-workspace.png` | Default Overview workspace, view mode |
| `lap-analysis-workspace.png` | Lap Analysis workspace (`⌘2`) |
| `engine-focus-workspace.png` | Engine Focus workspace (`⌘3`) |
| `edit-mode.png` | Edit mode with grid visible, no tile selected |
| `add-tile-modal.png` | Add Tile palette open |
| `channel-inspector.png` | Channels inspector modal open |
| `math-channels-editor.png` | ƒ Math editor open |
| `command-palette.png` | ⌘K palette, no query typed |
| `shortcuts-overlay.png` | `?` overlay open |
| `help-modal.png` | Help & Wiki modal open |
| `lap-config-dialog.png` | Lap Config dialog open |
| `gps-track-basemap.png` | GPS Track widget with `dark` basemap |
| `sessions-panel-expanded.png` | Sessions panel with a session expanded |
| `footer-lap-compare.png` | Footer showing Main · Ref · Δ |

## Why not auto-captured?

Tauri windows live in user space and aren't easily scripted from outside the process. The PowerShell helper is the cheapest reliable path: drive the UI by hand, let the script handle the file plumbing.
