import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "crypto";

// Server-side cache for external API results, backed by public.api_cache
// (see supabase/schema.sql). Every read/write happens from an already
// owner-gated code path — this isn't itself an authorization boundary.
//
// TTLs are a judgment call, not a measured figure: long for embeddings
// (the same text always maps to the same vector — it should only ever
// go stale if the embedding model itself changes, not with time), short
// for place data (Google's own content can genuinely change).
export const CACHE_TTL_MS = {
  EMBEDDING: 1000 * 60 * 60 * 24 * 90, // 90 days
  PLACE_DETAILS: 1000 * 60 * 60 * 12, // 12 hours
  NEARBY_SEARCH: 1000 * 60 * 60 * 6, // 6 hours
} as const;

// A hash of the normalized request, not the raw params — same input
// always produces the same key regardless of object key order, so a
// repeat request from a different route or caller is still a cache hit.
// JSON.stringify's second argument, when given an array, acts as an
// allow-list of keys in that array's order — passing the sorted key
// list is what makes this deterministic without writing a custom
// stable-stringify.
export function cacheKey(namespace: string, params: Record<string, unknown>): string {
  const normalized = JSON.stringify(params, Object.keys(params).sort());
  const hash = createHash("sha256").update(normalized).digest("hex");
  return `${namespace}:${hash}`;
}

export async function getCached<T>(
  supabase: SupabaseClient,
  key: string,
): Promise<T | null> {
  const { data, error } = await supabase
    .from("api_cache")
    .select("value, expires_at")
    .eq("key", key)
    .maybeSingle();

  if (error || !data) {
    console.log(`[cache] miss: ${key}`);
    return null;
  }
  if (new Date(data.expires_at).getTime() <= Date.now()) {
    console.log(`[cache] expired: ${key}`);
    return null;
  }
  console.log(`[cache] hit: ${key}`);
  return data.value as T;
}

export async function setCached(
  supabase: SupabaseClient,
  key: string,
  value: unknown,
  ttlMs: number,
): Promise<void> {
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const { error } = await supabase
    .from("api_cache")
    .upsert({ key, value, expires_at: expiresAt });

  if (error) {
    // A cache write failure shouldn't fail the request that produced the
    // value being cached — worst case, the next request just misses too.
    console.error(`[cache] write failed for ${key}:`, error.message);
  }
}
