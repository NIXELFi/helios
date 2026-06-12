/**
 * telemetry-ingest — Supabase edge function accepting HTP/1 binary telemetry
 * frames (Content-Type: application/x-htp) or an equivalent JSON fallback
 * (Content-Type: application/json).
 *
 * Per valid frame:
 *   1. decode + validate (400 on failure),
 *   2. transcode each 1 s window to one Arrow IPC stream record batch,
 *   3. upsert one row per window into telemetry.staging_chunks (idempotent on
 *      session_id,group_key,seq; duplicates are reported, not errors),
 *   4. publish one downsampled live frame to Realtime Broadcast topic
 *      telemetry:live:{session_id} (failure logged, never fails ingestion),
 *   5. respond with ack/dup seqs and server timestamps for RTT measurement.
 *
 * Stateless except for the TTL'd channel-set cache in channel_sets.ts.
 */

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { authenticate } from "./auth.ts";
import { getChannelSet } from "./channel_sets.ts";
import { buildTimeColumnUs, windowToArrowIPC } from "./arrow.ts";
import {
  type ChannelGroup,
  type ChannelSetDefinition,
  type DecodedFrame,
  DefinitionError,
  FrameError,
  decodeFrame,
  decodeJsonFrame,
  groupRateHz,
  parseHeader,
  peekJsonChannelSetId,
} from "./frame.ts";

const DEFAULT_MAX_BODY_BYTES = 65_536;

interface StagingRow {
  session_id: string;
  channel_set_id: number;
  group_key: number;
  seq: number;
  t_start_us: number;
  /** bytea via PostgREST: hex string with a \x prefix */
  payload: string;
  sample_count: number;
}

interface IngestAck {
  acked: number[];
  dup: number[];
  live_published: boolean;
  server_recv_ms: number;
  server_send_ms: number;
}

let client: SupabaseClient | null = null;

function supabase(): SupabaseClient {
  if (client === null) {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) {
      throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured");
    }
    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

function maxBodyBytes(): number {
  const raw = Deno.env.get("MAX_BODY_BYTES");
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_BODY_BYTES;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  const serverRecvMs = Date.now();

  if (req.method !== "POST") {
    return jsonResponse(405, { error: "method not allowed; POST only" });
  }

  // Size cap: trust Content-Length when present, verify actual length after.
  const limit = maxBodyBytes();
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) {
    return jsonResponse(413, { error: `body exceeds ${limit} bytes` });
  }
  const body = new Uint8Array(await req.arrayBuffer());
  if (body.byteLength > limit) {
    return jsonResponse(413, { error: `body exceeds ${limit} bytes` });
  }

  const auth = await authenticate(req, body);
  if (!auth.ok) {
    return jsonResponse(401, { error: "unauthorized" });
  }

  const contentType = (req.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();

  const outcome = await decodeRequest(contentType, body);
  if (!outcome.ok) return outcome.response;
  const { frame, group } = outcome;

  const rateHz = groupRateHz(group);
  const channelIds = group.channels.map((ch) => ch.id);

  // 2. Transcode each window to one Arrow IPC stream record batch.
  const rows: StagingRow[] = frame.windows.map((win, i) => {
    const timeUs = buildTimeColumnUs(win.tStartUs, rateHz);
    const ipc = windowToArrowIPC(
      channelIds,
      timeUs,
      channelIds.map((id) => win.samples[id]),
    );
    return {
      session_id: frame.sessionId,
      channel_set_id: frame.channelSetId,
      group_key: frame.groupKey,
      seq: frame.firstSeq + i,
      t_start_us: Number(win.tStartUs),
      payload: toByteaHex(ipc),
      sample_count: timeUs.length,
    };
  });

  // 3. Idempotent insert. With ignoreDuplicates (ON CONFLICT DO NOTHING) the
  //    returned representation contains only rows actually inserted, so any
  //    frame seq missing from it was a duplicate.
  const { data: inserted, error: insertError } = await supabase()
    .schema("telemetry")
    .from("staging_chunks")
    .upsert(rows, {
      onConflict: "session_id,group_key,seq",
      ignoreDuplicates: true,
    })
    .select("seq");

  if (insertError) {
    console.error("staging_chunks upsert failed:", insertError.message);
    return jsonResponse(500, { error: `insert failed: ${insertError.message}` });
  }

  const insertedSeqs = new Set((inserted ?? []).map((r: { seq: number }) => r.seq));
  const acked = rows.map((r) => r.seq);
  const dup = acked.filter((seq) => !insertedSeqs.has(seq));

  // 4. Best-effort live broadcast — never fails the ingest.
  const livePublished = await publishLive(frame, group, rateHz);

  const ack: IngestAck = {
    acked,
    dup,
    live_published: livePublished,
    server_recv_ms: serverRecvMs,
    server_send_ms: Date.now(),
  };
  return jsonResponse(200, ack);
});

type DecodeOutcome =
  | { ok: true; frame: DecodedFrame; group: ChannelGroup }
  | { ok: false; response: Response };

/** Dispatches on content type, loads the channel set, decodes, maps errors. */
async function decodeRequest(contentType: string, body: Uint8Array): Promise<DecodeOutcome> {
  try {
    let def: ChannelSetDefinition | null;
    let frame: DecodedFrame;

    if (contentType === "application/x-htp") {
      const header = parseHeader(body);
      def = await getChannelSet(supabase(), header.channelSetId);
      if (def === null) {
        return fail(400, `unknown channel_set_id ${header.channelSetId}`);
      }
      frame = decodeFrame(body, def);
    } else if (contentType === "application/json") {
      let raw: unknown;
      try {
        raw = JSON.parse(new TextDecoder().decode(body));
      } catch {
        return fail(400, "invalid JSON body");
      }
      const channelSetId = peekJsonChannelSetId(raw);
      def = await getChannelSet(supabase(), channelSetId);
      if (def === null) {
        return fail(400, `unknown channel_set_id ${channelSetId}`);
      }
      frame = decodeJsonFrame(raw, def);
    } else {
      return fail(415, "unsupported content type; use application/x-htp or application/json");
    }

    // Decode validated the group's existence, so this lookup cannot miss.
    const group = def.groups[String(frame.groupKey)];
    return { ok: true, frame, group };
  } catch (err) {
    if (err instanceof FrameError) {
      return fail(400, err.message);
    }
    if (err instanceof DefinitionError) {
      console.error("invalid channel set definition:", err.message);
      return fail(500, `invalid channel set definition: ${err.message}`);
    }
    console.error("ingest failure:", err);
    return fail(500, "internal error");
  }
}

function fail(status: number, error: string): DecodeOutcome {
  return { ok: false, response: jsonResponse(status, { error }) };
}

/**
 * Publishes one downsampled live frame (last sample of the last window) to
 * Realtime Broadcast topic telemetry:live:{session_id} over the HTTP
 * broadcast endpoint.
 */
async function publishLive(
  frame: DecodedFrame,
  group: ChannelGroup,
  rateHz: number,
): Promise<boolean> {
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) return false;

    const lastWindow = frame.windows[frame.windows.length - 1];
    const lastTimeUs =
      lastWindow.tStartUs + BigInt(Math.round(((rateHz - 1) * 1_000_000) / rateHz));
    const values: Record<string, number> = {};
    for (const ch of group.channels) {
      const samples = lastWindow.samples[ch.id];
      values[ch.id] = samples[samples.length - 1];
    }

    const res = await fetch(`${url}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        messages: [
          {
            topic: `telemetry:live:${frame.sessionId}`,
            event: "live",
            payload: {
              seq: frame.firstSeq + frame.windows.length - 1,
              send_timestamp_ms: frame.sendTimestampMs,
              t_us: Number(lastTimeUs),
              values,
            },
          },
        ],
      }),
    });
    if (!res.ok) {
      console.error(`broadcast failed: HTTP ${res.status} ${await res.text()}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("broadcast failed:", err);
    return false;
  }
}

/**
 * PostgREST bytea wants hex ('\x...') or base64; hex with the \x prefix is
 * the unambiguous supabase-js-safe form.
 */
function toByteaHex(bytes: Uint8Array): string {
  let out = "\\x";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}
