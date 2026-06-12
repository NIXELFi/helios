# HTP/1 — Helios Telemetry Protocol v1

Wire format from the car (ESP32 + cellular modem) to the `telemetry-ingest`
Supabase edge function. This document is self-contained: a firmware engineer
should be able to implement the uplink side without reading any other code in
this repo.

Design constraints, in priority order:

1. **MCU-friendly.** Fixed layouts, no dynamic schemas, no nesting. A frame is
   built with `memcpy` of packed little-endian structs. A full batch fits in a
   few KB of RAM.
2. **At-least-once delivery over bad cellular.** Sequence numbers + server
   acks + client retry. Duplicates are deduped server-side; the client never
   has to track server state beyond "highest acked seq".
3. **Bandwidth-frugal.** A curated channel subset at modest rates. Fixed-point
   encoding where it saves meaningful bytes. Realistic uplink budget is
   hundreds of kbps, not megabits.

Arrow IPC is **never** on the wire from the car. The edge function transcodes
each validated window into an Arrow IPC record batch; Arrow is the canonical
format from that point inward (staging, compaction, parquet, web reads).

## 1. Transport

- HTTPS `POST {SUPABASE_URL}/functions/v1/telemetry-ingest`
- `Content-Type: application/x-htp` (binary frame, below)
- A JSON fallback exists for debugging (§7); firmware uses binary only.
- Response is JSON (§6). Responses are small (< 512 bytes) and flat.

### Auth headers (one of)

| Method | Headers | Notes |
|---|---|---|
| Shared HMAC (firmware) | `x-htp-device: <device-id>`<br>`x-htp-signature: <hex hmac-sha256 of raw body>` | Key is `TELEMETRY_HMAC_KEY`, provisioned per device at flash time. |
| Service role JWT (tooling) | `Authorization: Bearer <service_role>` | Bench/replay tooling only. Never on the car. |

## 2. Sessions, channel sets, groups, windows, seqs

- A **session** is one logical run (test day stint). `session_id` is a UUIDv4
  assigned when the session is created (by the pit-side tool or the bench).
  The car receives it at session start (out of band — e.g. config push or
  hardcoded per flash for now).
- A **channel set** (`channel_set_id`, u16) is a registered, ordered list of
  channels with rates and encodings, stored in `telemetry.channel_sets`.
  Firmware and server agree on it ahead of time; the wire carries only the id.
  Changing the transmitted channels = registering a new set id. Sets are
  immutable once used.
- A channel set is partitioned into **groups** (`group_key`, u8). All channels
  in one group have the **same rate**; mixing rates within a group is
  rejected at registration. (This keeps each window a dense rectangle — no
  per-channel sample counts on the wire.)
- A **window** is exactly 1 second of samples for one group. A channel at
  `rate_hz` contributes exactly `rate_hz` samples per window.
- **seq** (u32) numbers windows per `(session, group)`, starting at 0,
  incrementing by 1 per window with no gaps. The (session_id, group_key, seq)
  triple is the idempotency key — retries are safe.

## 3. Frame layout

All integers little-endian. No padding — structs below are byte-exact.

### 3.1 Header (36 bytes)

| Offset | Size | Field | Notes |
|---|---|---|---|
| 0 | 2 | `magic` u16 | `0x4854` ("HT" little-endian) |
| 2 | 1 | `version` u8 | `1` |
| 3 | 1 | `flags` u8 | reserved, must be `0` |
| 4 | 16 | `session_id` | RFC 4122 byte order (as printed, hyphens removed) |
| 20 | 2 | `channel_set_id` u16 | registered set |
| 22 | 1 | `group_key` u8 | group within the set |
| 23 | 1 | `window_count` u8 | 1..=8 windows per frame |
| 24 | 4 | `seq` u32 | seq of the FIRST window; windows are consecutive |
| 28 | 8 | `send_timestamp_ms` u64 | unix ms at send; used for end-to-end latency |

### 3.2 Windows (`window_count` of these, back to back)

| Size | Field | Notes |
|---|---|---|
| 8 | `t_start_us` u64 | absolute unix µs of the window start |
| … | samples | for each channel in the group, **in registered order**: `rate_hz` consecutive samples in the channel's encoding |

Sample `i` of a channel at `rate_hz` has timestamp
`t_start_us + i * (1_000_000 / rate_hz)` (integer division; rates are chosen
so this divides evenly: 1, 2, 4, 5, 10, 20, 25, 50, 100 Hz).

### 3.3 Encodings

| enc | Size | Decode | Use when |
|---|---|---|---|
| `f32` | 4 | IEEE 754 float32 LE | full-precision channels (GPS lat/lon use two f32s? **No** — see below) |
| `i16fp` | 2 | `value = raw * scale + offset` (raw is int16 LE) | bounded physical channels |

- `scale`/`offset` are part of the channel set registration, not the wire.
- `i16fp` resolution **is** the channel's documented precision: the integrity
  differ asserts exact match at that resolution (encode→decode is bit-stable).
- `f32` channels must round-trip **bit exact** end to end.
- NaN encoding for `i16fp` (sensor dropout): raw `0x8000` (INT16_MIN) is the
  null sentinel, decoded to null/NaN, never to a value.
- GPS latitude/longitude need more than f32 precision (~2.4 m at f32 near
  ±112°). Encode each as **two** registered channels: `gps.lat` as `i32fp`?
  No — to keep exactly two encodings, GPS lat/lon are registered as `f32`
  **delta pairs**: `gps.lat_ref`/`gps.lon_ref` (f32, the session reference
  point, sent every window) and `gps.lat_d`/`gps.lon_d` (f32, delta from ref).
  Delta from a track-local reference keeps the error < 1 cm. The edge function
  reconstructs `gps.lat = ref + d` into a float64 Arrow column. (If this
  proves annoying in practice, HTP/2 adds an `f64` encoding; the version byte
  exists for exactly that.)

### 3.4 Size math (worked example)

Channel set "SDM26-cell-v1", group 0 (10 Hz, 30 channels, all `i16fp`),
group 1 (10 Hz GPS, 4 × f32):

- Group 0 window: 8 + 30 ch × 10 samples × 2 B = **608 B**
- Frame with 4 windows: 36 + 4 × 608 = **2468 B** ≈ 2.4 KB → fits ESP32 RAM
  budget; at 1 frame per 4 s that's ~5 kbps before HTTP/TLS overhead.
- A 40-channel mixed 1–10 Hz set stays well under 1 KB/s of payload.

## 4. Client behavior (the generator implements this exactly; firmware copies it)

1. Maintain a **bounded retry queue** (default 32 windows ≈ 32 s) of encoded
   windows not yet acked. If the queue overflows, drop the **oldest** window
   and count it (`dropped_oldest` counter) — live freshness beats completeness
   on the uplink; full data arrives later via CSV import.
2. Batch up to `window_count ≤ 8` consecutive pending windows per POST
   (fewer when the queue is short; don't wait more than 1 window period to
   send).
3. On 200: remove every seq in `acked` ∪ `dup` from the queue.
4. On timeout / 5xx / network error: exponential backoff 1 s → 2 s → 4 s
   (cap 8 s) with ±20 % jitter, then resend the same frame (same seqs —
   server dedupes).
5. On 400 (malformed) or 401 (auth): do **not** retry the frame; increment a
   permanent-error counter and continue with the next windows (a poison frame
   must not wedge the queue).
6. Clock: `t_start_us` comes from GPS time (fallback: RTC synced at session
   start). `send_timestamp_ms` is best-effort and only used for latency
   measurement, never for data placement.

## 5. Server behavior (normative summary)

1. Validate magic/version/flags, auth, known `(channel_set_id, group_key)`,
   `window_count ∈ 1..=8`, and **exact** body length
   `36 + window_count × (8 + Σ rate·width)`. Any failure → 400 + reason
   (or 401/413), nothing persisted.
2. Per window: transcode to one Arrow IPC stream record batch
   (`time_us` int64 + one float64 nullable column per channel id) and upsert
   into `telemetry.staging_chunks` keyed `(session_id, group_key, seq)`,
   `ON CONFLICT DO NOTHING`. Conflicted seqs are reported in `dup`.
3. Publish one downsampled live frame (latest value per channel +
   `send_timestamp_ms`) to Realtime Broadcast `telemetry:live:{session_id}`.
   Broadcast failure never fails ingestion.
4. Respond:

## 6. Ack response (JSON, 200)

```json
{
  "acked":   [1042, 1043, 1044],
  "dup":     [1041],
  "live_published": true,
  "server_recv_ms": 1781234567890,
  "server_send_ms": 1781234567905
}
```

`acked ∪ dup` = "durably staged, stop retrying". `server_*_ms` lets the
client split network vs server time in its round-trip measurement.

Errors: `{"error": "<reason>"}` with 400/401/413/500. 5xx ⇒ retry; 4xx ⇒ drop
frame and count it.

## 7. JSON debug fallback

`Content-Type: application/json`, same semantics, for curl/devtools poking:

```json
{
  "session_id": "9b2f…",
  "channel_set_id": 1,
  "group_key": 0,
  "seq": 1042,
  "send_timestamp_ms": 1781234567890,
  "windows": [
    { "t_start_us": 1781234560000000,
      "samples": { "engine.rpm": [8123.0, 8204.5], "engine.water_temp": [88.1] } }
  ]
}
```

## 8. C encoding sketch (non-normative)

```c
#pragma pack(push, 1)
typedef struct {
  uint16_t magic;          // 0x4854
  uint8_t  version;        // 1
  uint8_t  flags;          // 0
  uint8_t  session_id[16];
  uint16_t channel_set_id;
  uint8_t  group_key;
  uint8_t  window_count;
  uint32_t seq;
  uint64_t send_timestamp_ms;
} htp_header_t;             // 36 bytes
#pragma pack(pop)

// per window: write u64 t_start_us, then for each channel in set order,
// rate_hz samples: f32 -> memcpy 4B; i16fp -> (int16_t)lroundf((v - off)/scale)
// (clamp to INT16_MIN+1..INT16_MAX; INT16_MIN is the null sentinel)
```

HMAC: `mbedtls_md_hmac(MBEDTLS_MD_SHA256, key, keylen, body, bodylen, out)`,
hex-encode lowercase into `x-htp-signature`.

## 9. Versioning

`version` byte gates layout. Servers reject unknown versions with 400 so old
firmware fails loudly, not subtly. Planned HTP/2 candidates: f64 encoding,
per-frame compression (heatshrink/zstd-dict), CBOR negotiation. None are
needed for the bench milestone.
