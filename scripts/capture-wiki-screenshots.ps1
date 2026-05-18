<#
.SYNOPSIS
  Captures screenshots of the running Helios desktop window for the wiki.

.DESCRIPTION
  Walks you through a fixed checklist of UI states, prompting between shots
  so you can navigate the app manually. Each capture is saved to
  docs/wiki/images/ with the conventional filename used elsewhere in the wiki.

  Why not fully automatic? Tauri windows live in user space and aren't
  scriptable from outside the process; the cheapest reliable way to get
  consistent screenshots is to drive the UI by hand and let the script
  handle the capture and filename.

.USAGE
  1. In one terminal:   pnpm dev   (let Helios open)
  2. In another:        pwsh -File scripts\capture-wiki-screenshots.ps1
  3. Follow the prompts. Press Enter between shots.

.NOTES
  Output is a full-screen capture. Crop to the Helios window after if needed.
#>

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$ImagesDir = Join-Path $RepoRoot "docs\wiki\images"
if (-not (Test-Path $ImagesDir)) { New-Item -ItemType Directory -Path $ImagesDir | Out-Null }

function Capture($name, $description) {
    Write-Host ""
    Write-Host "  → Set up: $description" -ForegroundColor Yellow
    Read-Host "    Press Enter when ready to capture"

    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $path = Join-Path $ImagesDir "$name.png"
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Write-Host "    Saved $path" -ForegroundColor Green
}

Write-Host "Helios wiki screenshot capture" -ForegroundColor Cyan
Write-Host "Output dir: $ImagesDir" -ForegroundColor Cyan
Write-Host ""

Capture "overview-workspace" "Default Overview workspace, no edit mode, no modals open"
Capture "lap-analysis-workspace" "Switch to the Lap Analysis workspace (Cmd+2)"
Capture "engine-focus-workspace" "Switch to the Engine Focus workspace (Cmd+3)"
Capture "edit-mode" "Enter edit mode (Cmd+E); grid visible, no tile selected"
Capture "add-tile-modal" "Open the Add Tile modal (+ Add tile)"
Capture "channel-inspector" "Open the Channels inspector modal (header → Channels)"
Capture "math-channels-editor" "Open the Math channels editor (header → f Math)"
Capture "command-palette" "Open the command palette (Cmd+K), no query typed"
Capture "shortcuts-overlay" "Open the keyboard shortcuts overlay (?)"
Capture "help-modal" "Open the Help & Wiki modal (header → Help, or F1)"
Capture "lap-config-dialog" "Open Lap Config dialog from a session's expander"
Capture "gps-track-basemap" "Workspace with GPS Track on dark basemap"
Capture "sessions-panel-expanded" "Sessions panel with a session expanded showing the lap list"
Capture "footer-lap-compare" "Lap Analysis workspace with both Main and Ref laps set (footer shows Delta)"

Write-Host ""
Write-Host "All screenshots captured. Crop if needed and commit." -ForegroundColor Green
