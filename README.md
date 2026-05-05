# Helios

Sun Devil Motorsports ground-station telemetry suite.

## Quick start

```bash
pnpm install
pnpm dev
```

## Documentation

- Design spec: `docs/superpowers/specs/2026-05-04-helios-design.md`
- Architecture: `docs/architecture.md`
- Channel registry: `docs/channels.yaml`

## Repo layout

- `apps/desktop/` — Tauri shell + React frontend
- `crates/` — Rust crates (channel store core, CSV loader, Arrow helpers)
- `packages/` — TypeScript packages (store bridge, widgets, UI primitives)
- `samples/` — bundled sample sessions
- `fixtures/` — test fixtures

## Tests

```bash
pnpm test       # all TS tests
cargo test      # all Rust tests
```
