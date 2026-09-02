# telemetry-ingest

Supabase edge function (Deno 2) that ingests HTP/1 (Helios Telemetry Protocol
v1) frames, transcodes each 1-second window to an Arrow IPC stream record
batch, stages it in `telemetry.staging_chunks`, and publishes a downsampled
live sample to Realtime Broadcast.

**Status: draft.** Not deployed; intended for review and testing on another
machine.

## Files

| File | Purpose |
| --- | --- |
| `index.ts` | HTTP entrypoint: auth, size cap, decode dispatch, staging upsert, broadcast, ack |
| `frame.ts` | HTP/1 binary decoder + JSON-fallback decoder (pure, no I/O) |
| `arrow.ts` | window -> Arrow IPC stream record batch (`npm:apache-arrow@17`) |
| `auth.ts` | service-role bearer + device HMAC (constant-time via `crypto.subtle.verify`) |
| `channel_sets.ts` | TTL-cached loader for `telemetry.channel_sets.definition` |
| `frame_test.ts` | pure `deno test` coverage of the decoder (no network) |

## Environment variables

| Var | Required | Default | Meaning |
| --- | --- | --- | --- |
| `SUPABASE_URL` | yes | — | project URL (auto-injected on the platform) |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | — | service-role key: DB writes, broadcast, and bearer auth comparison |
| `TELEMETRY_HMAC_KEY` | for device auth | — | shared HMAC-SHA256 key for `x-htp-signature` |
| `MAX_BODY_BYTES` | no | `65536` | request body hard cap; larger bodies get 413 |
| `TELEMETRY_CHANNEL_SET_TTL_MS` | no | `30000` | channel-set cache TTL (per isolate) |

## Auth

Either of:

1. `Authorization: Bearer <service_role key>` (exact match against
   `SUPABASE_SERVICE_ROLE_KEY`), or
2. device HMAC: `x-htp-device: <device id>` plus
   `x-htp-signature: hex(HMAC-SHA256(raw_body, TELEMETRY_HMAC_KEY))`.

Otherwise 401. Note: the function does its own auth, so the platform's JWT
check should be disabled for this function (`--no-verify-jwt` locally, or
`[functions.telemetry-ingest] verify_jwt = false` in `config.toml`) —
otherwise HMAC-only devices are rejected before the function runs.

## Database expectations

PostgREST must expose the `telemetry` schema (Dashboard -> API -> exposed
schemas, or `db.schemas` in config). Tables, roughly:

```sql
create table telemetry.channel_sets (
  id         int primary key,
  definition jsonb not null
  -- definition: { "groups": { "<group_key>": { "channels":
  --   [{ "id": "rpm", "rate_hz": 100, "enc": "f32" },
  --    { "id": "coolant_c", "rate_hz": 100, "enc": "i16fp", "scale": 0.1, "offset": -40 }] } } }
  -- All channels within one group MUST share the same rate_hz.
);

create table telemetry.staging_chunks (
  session_id     uuid   not null,
  channel_set_id int    not null,
  group_key      int    not null,
  seq            bigint not null,
  t_start_us     bigint not null,
  payload        bytea  not null,  -- Arrow IPC stream, one record batch
  sample_count   int    not null,  -- rows in the batch (= group rate_hz)
  primary key (session_id, group_key, seq)
);
```

The unique constraint on `(session_id, group_key, seq)` is what makes the
upsert (`ignoreDuplicates: true`) idempotent for at-least-once clients.

## Serve locally

```sh
cd infra/telemetry-supabase
supabase start
echo 'TELEMETRY_HMAC_KEY=dev-secret' > supabase/functions/.env.local
supabase functions serve telemetry-ingest --env-file supabase/functions/.env.local --no-verify-jwt
```

`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are injected automatically by
`supabase functions serve`.

## curl example (JSON fallback)

Assumes channel set 7 registered with group `"3"` = channels `rpm` and
`coolant_c`, both 4 Hz:

```sh
curl -i http://127.0.0.1:54321/functions/v1/telemetry-ingest \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -d '{
    "session_id": "0f8fad5b-d9cb-469f-a165-70867728950e",
    "channel_set_id": 7,
    "group_key": 3,
    "seq": 41,
    "send_timestamp_ms": 1765432100123,
    "windows": [
      {
        "t_start_us": 1765432100000000,
        "samples": {
          "rpm": [1500, 1520, 1490, 1510],
          "coolant_c": [82.1, 82.2, 82.2, 82.3]
        }
      }
    ]
  }'
```

Successful response:

```json
{
  "acked": [41],
  "dup": [],
  "live_published": true,
  "server_recv_ms": 1765432100200,
  "server_send_ms": 1765432100215
}
```

`dup` lists seqs already staged (idempotent retry); they are still acked.
Clients measure round trip from `send_timestamp_ms` vs
`server_recv_ms`/`server_send_ms`.

Binary clients POST the same semantics with `Content-Type: application/x-htp`
(frame layout documented at the top of `frame.ts`).

## Live broadcast

One message per frame (not per window) to Realtime Broadcast topic
`telemetry:live:{session_id}`, event `live`, payload:

```json
{ "seq": <last window seq>, "send_timestamp_ms": ..., "t_us": <last sample time>, "values": { "<channel_id>": <last sample value> } }
```

Broadcast failure never fails ingestion; it only sets `live_published: false`.

## Tests

```sh
deno test supabase/functions/telemetry-ingest/frame_test.ts
```

Pure decoder tests, no network or Supabase needed.

## Assumptions / open questions

- `telemetry.channel_sets` key column is named `id`; adjust
  `channel_sets.ts` if it differs.
- `sample_count` is rows in the record batch (= group `rate_hz`), not
  rows x channels.
- The live broadcast `seq` is the seq of the **last** window in the frame
  (matching `t_us`/`values`, which come from that window's last sample).
- The broadcast topic is published as non-private; if Realtime
  authorization (private channels) is enabled on the project, add
  `"private": true` to the message and matching RLS policies.
- A malformed *registered* definition (mixed rates in a group, unknown enc)
  returns 500, since it is a server-side configuration error, not a client
  decode error (those return 400).
- `flags` bits 1..7 are currently accepted (only bit0 is specified as
  reserved-must-be-zero). Tighten to reject any nonzero flags if preferred.
- Header `send_timestamp_ms` is read as u64 but surfaced as a JS number
  (safe far beyond any realistic unix-ms value).
