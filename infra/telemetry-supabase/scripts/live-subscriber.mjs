#!/usr/bin/env node
/**
 * Realtime Broadcast subscriber for the live telemetry path: subscribes to
 * telemetry:live:{session} and measures end-to-end broadcast latency
 * (now - send_timestamp_ms; valid when generator and subscriber share a
 * clock, e.g. same machine). Writes a JSON summary on SIGTERM/duration end.
 *
 *   node live-subscriber.mjs <session_id> <duration_s> <out.json>
 * Env: SUPABASE_URL, SUPABASE_ANON_KEY
 */
import { createRequire } from "node:module";
// resolve supabase-js from infra/pdm-supabase's installed deps
const require = createRequire(
  new URL("../../pdm-supabase/package.json", import.meta.url),
);
const { createClient } = require("@supabase/supabase-js");

const [sid, durationS, outPath] = process.argv.slice(2);
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_ANON_KEY;
if (!sid || !url || !key) {
  console.error("usage: live-subscriber.mjs <session_id> <duration_s> <out.json> (+ env)");
  process.exit(2);
}

// node 20 has no global WebSocket; borrow ws from the workspace's pnpm store
// (ws is not a root dependency, so resolve it by direct path)
import { readdirSync } from "node:fs";
const pnpmDir = new URL("../../../node_modules/.pnpm/", import.meta.url).pathname;
const wsEntry = readdirSync(pnpmDir).find((d) => d.startsWith("ws@"));
const WebSocket = createRequire(import.meta.url)(
  `${pnpmDir}${wsEntry}/node_modules/ws`,
);

const client = createClient(url, key, {
  auth: { persistSession: false },
  realtime: { transport: WebSocket },
});
const latencies = [];
let received = 0;

const channel = client
  .channel(`telemetry:live:${sid}`)
  .on("broadcast", { event: "live" }, ({ payload }) => {
    received++;
    if (typeof payload?.send_timestamp_ms === "number") {
      latencies.push(Date.now() - payload.send_timestamp_ms);
    }
  })
  .subscribe((status) => console.error(`subscriber: ${status}`));

const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};

setTimeout(async () => {
  await client.removeChannel(channel);
  const summary = {
    received,
    latency_ms: {
      p50: pct(latencies, 0.5),
      p95: pct(latencies, 0.95),
      p99: pct(latencies, 0.99),
      min: latencies.length ? Math.min(...latencies) : null,
      max: latencies.length ? Math.max(...latencies) : null,
    },
  };
  const { writeFileSync } = await import("node:fs");
  writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.error(`subscriber: done, ${received} frames -> ${outPath}`);
  process.exit(0);
}, Number(durationS) * 1000 + 5000);
