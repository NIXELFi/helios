# Cellular Telemetry — Fast Live Path + Firmware Scaffold (design spec)

**Date:** 2026-09-02 · **Status:** approved by Nick in conversation ("500 ms is fine, plan this all out")
**Target:** ≤ 500 ms glass-to-glass (sensor on the car → engineer's Helios screen), with the
existing HTP/1 durable ingest left intact underneath.

This spec records the decisions. Two implementation plans execute it:

- `docs/superpowers/plans/2026-09-02-telemetry-live-path-server.md` — Helios monorepo
  (protocol crate, migrations, edge function, reference client, Logs live source).
- `docs/superpowers/plans/2026-09-02-telemetry-firmware.md` — new repo `sdm-telemetry-fw`
  (ESP32-S3 + LTE firmware, PlatformIO / ESP-IDF).

---

## 1. What already exists (do not rebuild)

Branch `origin/feat/telemetry-pipeline` (June 2026) — **deployed to prod, soak-tested**:

| Piece | Where | State |
|---|---|---|
| HTP/1 wire protocol | `docs/telemetry-wire-protocol.md` | normative, unchanged by this work |
| Schema `telemetry.*` (sessions, channel_sets, staging_chunks, …) | `infra/telemetry-supabase/supabase/migrations/2026061220*.sql` | applied hosted, recorded in migration history |
| Edge function `telemetry-ingest` | `infra/telemetry-supabase/supabase/functions/telemetry-ingest/` | deployed; HMAC device auth (`x-htp-device`, `x-htp-signature`, env `TELEMETRY_HMAC_KEY`); stages Arrow IPC per window; also publishes a coarse `live` broadcast (1 value per channel per POST) |
| Compactor | `crates/helios-compactor` | staging → zstd parquet; runs nowhere yet |
| Channel set 1 `SDM26-cell-v1` | `infra/telemetry-supabase/supabase/seed.sql` | 3 groups: g0 = 22 × i16fp @ 10 Hz, g1 = 5 × f32 GPS @ 10 Hz, g2 = 11 × i16fp @ 1 Hz |

The branch merges onto `origin/main` cleanly except `Cargo.lock` (regenerate).

## 2. Latency budget (why the design is shaped this way)

| Stage, current design | ms |
|---|---|
| wait for 1 s window | 500 avg |
| wait for 4-window batch | up to 4000 |
| HTTPS POST RTT (Cat-M1) | 150–300 |
| edge fn (warm / cold) | 50–150 / 500–1000 |
| Realtime broadcast (soak p50) | 434 |
| **≈ 5 s** | |

| Stage, this design | ms |
|---|---|
| wait for 100 ms live tick | 50 avg |
| WebSocket publish RTT (Cat-1) | ~80 |
| Realtime fan-out | 250–400 |
| client ring-buffer → rAF draw | ≤ 16 |
| **≈ 400–550** | |

Realtime fan-out is the floor. The only way below it is a self-hosted relay; **explicitly out of
scope** (documented escalation only).

## 3. Decisions

### 3.1 Split live from durable
- **Live path:** the car holds one WebSocket to Supabase Realtime and broadcasts a compact
  message every 100 ms directly on the private channel `telemetry:live:{session_id}`, event
  `live_fast`. No edge function, no Postgres, no window in the loop.
- **Durable path:** unchanged HTP/1 POSTs to `telemetry-ingest`, batched 4 windows/frame
  (firmware knob). Its latency no longer matters. Its own `live` broadcast stays as-is (different
  event name, harmless; clients prefer `live_fast` when present).

### 3.2 Live message format (`live_fast`)
Realtime payloads are JSON; values ride as a base64 binary blob to keep it ~250 B:

```json
{ "seq": 12345, "t_us": 1781234560100000, "t_send_ms": 1781234560112,
  "cs": 1, "v": "<base64>" }
```

`v` = for each group in ascending `group_key`, for each channel in registered order, **one**
sample encoded per the channel set (i16fp → int16 LE with `0x8000` = null; f32 → IEEE LE). For
channel set 1 that is 22×2 + 5×4 + 11×2 = **86 bytes → 116 chars base64**. `seq` is a plain
per-session live counter (u32, independent of HTP window seqs). `t_us` is the sample time from
GPS/RTC; `t_send_ms` is the device wall clock at send so the client can show glass latency when
the device clock is GPS-synced.

Cadence default **10 Hz** (`LIVE_HZ` firmware knob). Realtime quota note: Supabase counts
messages sent *and* delivered. 10 Hz × 6 h × (1 sender + N subscribers): with 5 viewers ≈
1.3 M messages per test day against Pro's 5 M/month. If that bites, drop `LIVE_HZ` to 5 (adds
~50 ms average latency, still inside budget). This is a knob, not a design change.

### 3.3 Device identity for the live path
Realtime needs a JWT. Devices get a **long-lived HS256 device JWT** minted offline with the
project's JWT secret (`scripts/mint-device-jwt.mjs`, plan A task 3):

```json
{ "role": "authenticated", "aud": "authenticated", "sub": "device:<device_id>",
  "device_id": "<device_id>", "iss": "helios-telemetry-mint", "iat": …, "exp": iat + 365 d }
```

Authorization is enforced with RLS on `realtime.messages` (private channels):
- **publish** (`insert`): topic `like 'telemetry:live:%'` **and** `auth.jwt()->>'device_id' is not null`
- **subscribe** (`select`): topic `like 'telemetry:live:%'` for any `authenticated` user

Team members subscribe with their normal Helios login. Devices cannot subscribe to anything
else and cannot touch Postgres (no table grants involve the JWT — `authenticated` only has
`select` on `telemetry.*`, which is fine).

⚠ Risk to verify on day one: if the project has migrated to asymmetric JWT signing keys and the
legacy HS256 secret is disabled, HS256 device tokens are rejected. Check Dashboard → Settings →
JWT Keys; keep the legacy secret active (it is by default).

### 3.4 Session provisioning: device opens its own session
New edge function **`telemetry-session`** (HMAC auth, reuses `auth.ts`):

```
POST /functions/v1/telemetry-session   { "action": "open", "device_id": "sdm26-car-1",
                                         "channel_set_id": 1, "name": "optional" }
→ 200 { "session_id": "<uuid>", "channel_set_id": 1 }
POST …                                  { "action": "close", "session_id": "<uuid>" }
→ 200 { "closed": true }
```

`open` first closes any still-`live` session with the same `metadata->>'device_id'` (a reboot
must not strand a ghost session), then inserts `sessions(name, source='live', status='live',
started_at=now(), metadata={device_id, channel_set_id})`. `close` sets `status='ended',
ended_at=now()`. No pit-side tool is required to go live.

### 3.5 Helios Logs live source (desktop)
- New "Connect live" affordance next to "Add session" in `SessionPanel`; a dialog lists
  `telemetry.sessions where status = 'live'` (REST, schema `telemetry`).
- `packages/store/src/live-buffer.ts`: per-group ring buffers (default 10 min at group rate),
  `push(groupKey, tUs, values)`, `toStore(metas)` builds a fresh `ChannelStore` (the widget
  contract is immutable stores + `sessions` state; rebuilding ≤ 10×/s at 38 ch × 6000 samples is
  ~1 MB of copies — cheap).
- `apps/desktop/src/lib/live-session.ts`: subscribes to the private channel, decodes `live_fast`
  against the channel-set definition, pushes into the buffer, and commits a new store to React
  state **inside a `requestAnimationFrame` gate** (never per message).
- A live session is a normal `LoadedSession` with id `live:<session_id>`, label `LIVE · <name>`,
  `lapConfig` mode `none`. Removing it disconnects.

### 3.6 Protocol crate + golden fixtures = the contract between repos
`crates/helios-htp` (Rust) is the single source of truth for HTP/1 encode/decode **and** the
`live_fast` value packing. It generates golden fixtures (`fixtures/htp1/*.htp` + `.json`,
`fixtures/live/*.bin` + `.json`) that:
- the Rust tests roundtrip,
- the reference client `helios-telemetry-gen` uses to self-check,
- the firmware repo vendors and byte-compares in its host-native tests.

### 3.7 Reference client `crates/helios-telemetry-gen`
Subcommands: `open-session`, `replay` (CSV → HTP/1 POSTs at 1×/5×/10×), `live` (CSV or
synthetic → `live_fast` over WebSocket at `--hz`). It proves the whole chain **before any
hardware exists** and is what the Logs live source is developed against.

### 3.8 Hardware
- Bench unit for Wi-Fi milestone: **ESP32-S3-DevKitC-1 N8R8** (8 MB PSRAM).
- Car unit: **LILYGO T-SIM7670G-S3** (ESP32-S3 + SIM7670G Cat-1 bis + GNSS on one board).
  Cat-1 chosen over Cat-M1 for RTT (~50–100 ms vs 150–300), not bandwidth. Verify current
  availability on LILYGO's store before ordering; fallback is T-SIM7080G-S3 (Cat-M1, adds
  ~150 ms).
- **SN65HVD230** CAN transceiver breakout (3.3 V, TWAI).
- IoT SIM, pay-as-you-go (≈ 5 MB per hour of running at 4-window batching + live stream ≈ +9 MB/h;
  budget ~15 MB/h, ~100 MB per test day).

Firmware settings that matter for latency: **PSM and eDRX disabled**, PPPoS via `esp_modem`
(ESP does its own TLS; never the modem's AT HTTP stack), one persistent TLS session for the
HTP POSTs (keep-alive + session tickets), one persistent WebSocket for live.

### 3.9 Transport abstraction in firmware
`transport_start()` is selected at build time: `TRANSPORT_WIFI` (devkit) or `TRANSPORT_LTE`
(PPPoS). Everything above netif is identical — that is what lets the Wi-Fi milestone validate
HMAC, TLS keep-alive, framing, retry and the live WebSocket before the modem board arrives.

## 4. Out of scope (deliberately)
- HTP/2 (multi-group frames, shorter windows) — bandwidth only, no latency benefit after the split.
- Edge-function diet (raw HTP in staging) — the durable path's latency is irrelevant now.
- Helios Lite live view — same Realtime subscription + `live-buffer`, later.
- Compactor hosting — pit laptop/Pi; separate decision.
- Pit-side session tool — devices self-provision.
- Self-hosted relay below the Realtime floor.

## 5. Milestones / acceptance
1. **Server:** `helios-telemetry-gen live` from this Windows machine → Helios desktop shows a
   live strip chart with measured glass latency < 500 ms p50 (device clock = host clock).
2. **Firmware M0:** host-native tests byte-match every golden fixture.
3. **Firmware M1 (Wi-Fi devkit):** opens a session, streams synthetic `live_fast` at 10 Hz and
   HTP/1 frames at 4-window batching to **prod**; Helios shows it live; `staging_chunks` fills;
   acks/dups correct across a forced Wi-Fi drop.
4. **Firmware M2 (LTE):** same over PPPoS on the T-SIM7670G-S3, driving around the lot.
5. **Firmware M3 (CAN):** real Link G4X channels replace synthetic.
