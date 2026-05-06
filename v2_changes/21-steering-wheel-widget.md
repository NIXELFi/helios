# 21 — Steering Wheel widget

## Want

A glanceable view of steering input. A scalar number (`+27°`) reads but doesn't communicate "the driver is mid-corner-entry" the way a rotating wheel does.

## Add

Canvas-rendered steering wheel that rotates in sync with the configured channel. Three spokes (top, 8 o'clock, 4 o'clock) and a gold pip on the rim so even small inputs read clearly. Faint outer ring with tick marks at 0 and ±maxAngle gives a passive scale. Numeric readout under the wheel turns red when |angle| > maxAngle (over-lock cue).

Config:
- `channelId` — picked from the available channel list
- `units` (default `°`)
- `maxAngle` (default 90)
- `invert` — flip sign when the data convention disagrees with what feels right behind the wheel

`docs/channels.yaml` gained `chassis.steering_angle` with the `Steering` alias so MoTeC ADL exports map straight in.

## Files changed

- [packages/widgets/src/steering-wheel/](../packages/widgets/src/steering-wheel/)
- [packages/widgets/tests/steering-wheel.test.tsx](../packages/widgets/tests/steering-wheel.test.tsx)
- [packages/widgets/src/index.ts](../packages/widgets/src/index.ts) — re-export
- [apps/desktop/src/components/Tile.tsx](../apps/desktop/src/components/Tile.tsx) — registry
- [apps/desktop/src/components/AddTileModal.tsx](../apps/desktop/src/components/AddTileModal.tsx) — palette
- [apps/desktop/src/components/ConfigPanel.tsx](../apps/desktop/src/components/ConfigPanel.tsx) — type-swap dropdown
- [apps/desktop/src/workspaces/types.ts](../apps/desktop/src/workspaces/types.ts) — `WidgetType` + `TileSpec` config union
- [docs/channels.yaml](../docs/channels.yaml)
