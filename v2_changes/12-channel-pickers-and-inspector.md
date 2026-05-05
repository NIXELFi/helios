# 12 — Channel pickers + Channels inspector modal

## Symptom / motivation

Phase 11 ([11](11-edit-mode-and-config-editor.md)) shipped the per-tile config editor, but every channel-id field was a plain text input. You had to know the exact canonical id (`engine.rpm`, `gps.lat`, …) and type it correctly. There was also no way to browse the channels actually present in a loaded session.

This commit fixes both: every channel-id input is a real dropdown of all channels in the primary session, and a new "Channels" button in the header opens a modal that lists every channel with its metadata.

## What this commit ships

### `ChannelPicker` — [packages/widgets/src/lib/channel-picker.tsx](../packages/widgets/src/lib/channel-picker.tsx)

A reusable dropdown that takes `value`, `onChange`, and `channels: ChannelMeta[]`:

- Options grouped by `ChannelMeta.group` (Engine, GPS, IMU, Unknown, …) using `<optgroup>`.
- Option label is `id · display_name (units)` so both forms are recognizable.
- If the saved `value` isn't in the available channel list (e.g. the workspace was authored against a different CSV), the missing id is still rendered as a top option with `(not in this session)` so the assignment is preserved instead of silently dropped.
- Optional `allowEmpty` for fields that can be cleared (`gearChannelId`, `colorByChannelId`).

The picker is exported from `@helios/widgets` so app-side code can also use it for future features.

### Widget interface — [packages/widgets/src/types.ts](../packages/widgets/src/types.ts)

`WidgetConfigEditorProps` now requires `availableChannels: ChannelMeta[]`. App code passes `primary.store.list()` into `<ConfigPanel>`, which forwards it into each widget's editor.

### Every channel-id input is now a `ChannelPicker`

Per-widget changes:

| Widget | Channel-id fields converted |
| - | - |
| bar-gauge | `channelId` |
| engine-bar | `rpmChannelId`, `gearChannelId` (optional) |
| gps-track | `latChannelId`, `lonChannelId`, `colorByChannelId` (optional) |
| histogram | `channelId` |
| numeric-readout | `channelId` |
| round-gauge | `channelId` |
| xy-plot | `xChannelId`, `yChannelId` |
| strip-chart | per-row `channels[].id` (with row delete button added while we were there) |
| tire-grid | 4 corners × `temp` + `pressure` (8 fields, laid out in a grid) |

`alarm-panel` and `lap-panel` don't have channel-id fields and are unaffected.

### `ChannelsModal` — [apps/desktop/src/components/ChannelsModal.tsx](../apps/desktop/src/components/ChannelsModal.tsx)

New "Channels" button in the header (left of the "Edit" toggle) opens a modal:

- Lists every resolved channel in the **primary session**, grouped by `ChannelMeta.group`, sorted by id.
- Per row: color swatch, id, display name, units, sample rate, min, max.
- Live filter input on top (matches against id, display name, or group).
- Read-only.

## What's intentionally NOT in this commit

- **Editing channel metadata.** No way yet to rename `Engine RPM` → `RPM`, change units, recolor a channel, or override min/max. Needs a per-session override layer or runtime updates to `docs/channels.yaml`; deferred so the persistence model gets thought through.
- **Remapping CSV columns to canonical ids.** The `channels.yaml` aliases system is currently the only way to re-route a column (e.g. `"Throttle Position" → engine.tps`). Runtime remapping requires either edits to that YAML or a session-local alias table; deferred.
- **Manual "this CSV header maps to X" UI.** Same constraint as above.

The modal's footer explicitly notes these are coming; the team can ask for them next.

## Files changed

- [packages/widgets/src/lib/channel-picker.tsx](../packages/widgets/src/lib/channel-picker.tsx) — new
- [packages/widgets/src/types.ts](../packages/widgets/src/types.ts)
- [packages/widgets/src/index.ts](../packages/widgets/src/index.ts) — re-export ChannelPicker
- [packages/widgets/src/bar-gauge/config-editor.tsx](../packages/widgets/src/bar-gauge/config-editor.tsx)
- [packages/widgets/src/engine-bar/config-editor.tsx](../packages/widgets/src/engine-bar/config-editor.tsx)
- [packages/widgets/src/gps-track/config-editor.tsx](../packages/widgets/src/gps-track/config-editor.tsx)
- [packages/widgets/src/histogram/config-editor.tsx](../packages/widgets/src/histogram/config-editor.tsx)
- [packages/widgets/src/numeric-readout/config-editor.tsx](../packages/widgets/src/numeric-readout/config-editor.tsx)
- [packages/widgets/src/round-gauge/config-editor.tsx](../packages/widgets/src/round-gauge/config-editor.tsx)
- [packages/widgets/src/xy-plot/config-editor.tsx](../packages/widgets/src/xy-plot/config-editor.tsx)
- [packages/widgets/src/strip-chart/config-editor.tsx](../packages/widgets/src/strip-chart/config-editor.tsx)
- [packages/widgets/src/tire-grid/config-editor.tsx](../packages/widgets/src/tire-grid/config-editor.tsx)
- [apps/desktop/src/components/ConfigPanel.tsx](../apps/desktop/src/components/ConfigPanel.tsx)
- [apps/desktop/src/components/ChannelsModal.tsx](../apps/desktop/src/components/ChannelsModal.tsx) — new
- [apps/desktop/src/App.tsx](../apps/desktop/src/App.tsx) — Channels button + modal mount, availableChannels through to ConfigPanel
