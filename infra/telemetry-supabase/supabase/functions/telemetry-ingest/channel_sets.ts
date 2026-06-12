/**
 * Channel set definitions, loaded from telemetry.channel_sets and cached in
 * module scope with a small TTL. The edge runtime keeps module scope alive
 * across requests within one isolate, so this is a per-isolate cache only —
 * there is no cross-isolate invalidation, hence the short TTL.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { type ChannelSetDefinition } from "./frame.ts";

const DEFAULT_TTL_MS = 30_000;

interface CacheEntry {
  def: ChannelSetDefinition | null; // null = known-missing (negative cache)
  expiresAt: number;
}

const cache = new Map<number, CacheEntry>();

function ttlMs(): number {
  const raw = Deno.env.get("TELEMETRY_CHANNEL_SET_TTL_MS");
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_TTL_MS;
}

/**
 * Returns the definition for a channel set id, or null if the id is not
 * registered. Throws on database errors.
 */
export async function getChannelSet(
  supabase: SupabaseClient,
  channelSetId: number,
): Promise<ChannelSetDefinition | null> {
  const now = Date.now();
  const hit = cache.get(channelSetId);
  if (hit && hit.expiresAt > now) return hit.def;

  const { data, error } = await supabase
    .schema("telemetry")
    .from("channel_sets")
    .select("definition")
    .eq("id", channelSetId)
    .maybeSingle();

  if (error) {
    throw new Error(`failed to load channel_set ${channelSetId}: ${error.message}`);
  }

  const def = (data?.definition as ChannelSetDefinition | undefined) ?? null;
  cache.set(channelSetId, { def, expiresAt: now + ttlMs() });
  return def;
}

/** Test hook / manual invalidation. */
export function clearChannelSetCache(): void {
  cache.clear();
}
