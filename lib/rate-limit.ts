import type { SupabaseClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";

// Per-minute, per-client throttling for routes that take no session at all
// (GET /api/pins, GET /api/maps-config) — public-read by product design
// (see CLAUDE.md), so there's no owner gate to lean on the way
// lib/api-auth.ts protects the metered routes. lib/usage.ts is a monthly
// cost breaker on Google calls specifically; this is a much shorter window
// meant to blunt scraping/abuse of the public routes themselves.
export const RATE_LIMITS = {
  PUBLIC_READ: { windowSeconds: 60, limit: 60 },
  // The suggester and nearby-recommendations demo routes have no owner
  // gate at all, and each call is expensive (an LLM call, or live Google
  // Places + embedding calls) rather than a cheap DB read — a much
  // tighter per-client window than PUBLIC_READ, on top of the separate
  // public_places_request monthly cap in lib/usage.ts for the Google side.
  PUBLIC_SUGGEST: { windowSeconds: 3600, limit: 5 },
  PUBLIC_NEARBY: { windowSeconds: 3600, limit: 5 },
} as const;

export type RateLimitKind = keyof typeof RATE_LIMITS;

// x-forwarded-for is attacker-controlled on a direct request, but this
// deployment sits behind Vercel's proxy, which sets/overwrites it with the
// real client IP as the first entry — good enough for a soft, best-effort
// throttle, not a security boundary.
export function clientIdentifier(request: NextRequest): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  const ip = forwardedFor?.split(",")[0]?.trim();
  return ip || "unknown";
}

export interface RateLimitResult {
  admitted: boolean;
  retryAfterSeconds: number;
}

export async function checkRateLimit(
  supabase: SupabaseClient,
  kind: RateLimitKind,
  identifier: string,
): Promise<RateLimitResult> {
  const { windowSeconds, limit } = RATE_LIMITS[kind];

  const { data, error } = await supabase.rpc("check_rate_limit", {
    p_key: `${kind}:${identifier}`,
    p_window_seconds: windowSeconds,
    p_limit: limit,
  });

  if (error) {
    // Fail open — a DB hiccup shouldn't take down public map reads.
    console.error(`[rate-limit] check failed for ${kind}:`, error.message);
    return { admitted: true, retryAfterSeconds: 0 };
  }

  return { admitted: data === true, retryAfterSeconds: windowSeconds };
}
