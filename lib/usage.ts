import type { SupabaseClient } from "@supabase/supabase-js";

// Self-imposed usage caps for Google Maps/Places, tracked in
// public.google_api_usage (see supabase/schema.sql). A Cloud Console
// quota or budget alert alone can't promise a $0 bill — this is the
// actual control: the app checks its own monthly counters and degrades
// itself *before* making the Google call that would otherwise cost
// money, rather than finding out after the fact.
//
// Defaults are deliberately conservative guesses for a two-person app
// with occasional public traffic, not a measured figure — tune via env
// vars, no code change needed. Map loads happen on every public page
// view (the higher-volume, less predictable side); places_request is
// the owners' own (signed-in) search usage, so a lower default there
// just caps an unexpected loop or bug, not normal usage.
const DEFAULT_MAPS_JS_LOAD_ALLOWANCE = 1500; // ~50/day
const DEFAULT_PLACES_REQUEST_ALLOWANCE = 300; // ~10/day
// The public suggester/nearby-recommendations demo has no auth gate at
// all, so its allowance is deliberately much smaller and tracked on its
// own counter — a spike in anonymous demo traffic degrades the demo
// itself, not the owners' own search allowance above.
const DEFAULT_PUBLIC_PLACES_REQUEST_ALLOWANCE = 60; // ~2/day

export type GoogleApiUsageKind =
  | "maps_js_load"
  | "places_request"
  | "public_places_request";

// Thrown by lib/google-places.ts when a cache miss would require an
// actual Google call and this month's places_request allowance is
// already spent. Kept distinct from a generic Error so callers can
// return 503 (usage limit) instead of 502 (upstream request failed) —
// those are different problems with different retry semantics.
export class UsageLimitError extends Error {
  constructor(message = "Google Places usage limit reached for this month.") {
    super(message);
    this.name = "UsageLimitError";
  }
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getMonthlyAllowance(kind: GoogleApiUsageKind): number {
  switch (kind) {
    case "maps_js_load":
      return envInt("GOOGLE_MAPS_MONTHLY_LOAD_ALLOWANCE", DEFAULT_MAPS_JS_LOAD_ALLOWANCE);
    case "public_places_request":
      return envInt(
        "GOOGLE_PUBLIC_PLACES_MONTHLY_REQUEST_ALLOWANCE",
        DEFAULT_PUBLIC_PLACES_REQUEST_ALLOWANCE,
      );
    case "places_request":
      return envInt(
        "GOOGLE_PLACES_MONTHLY_REQUEST_ALLOWANCE",
        DEFAULT_PLACES_REQUEST_ALLOWANCE,
      );
  }
}

export interface UsageAdmission {
  admitted: boolean;
  count: number;
  allowance: number;
}

// Checks this month's count for `kind` against its allowance, and only
// increments the counter if the caller is actually admitted — a refused
// call never reaches Google, so it must not be counted as if it had.
// This intentionally checks-then-increments as two round trips rather
// than one atomic RPC: a race between concurrent requests can let a
// handful through past the cap, which is acceptable for a soft,
// early-warning breaker sitting in front of the real hard quota
// configured in Google Cloud Console.
export async function admitGoogleApiUsage(
  supabase: SupabaseClient,
  kind: GoogleApiUsageKind,
): Promise<UsageAdmission> {
  const allowance = getMonthlyAllowance(kind);

  const { data: currentCount, error: readError } = await supabase.rpc(
    "get_google_api_usage",
    { p_kind: kind },
  );
  if (readError) {
    // Fail closed on the two unauthenticated surfaces (maps loads, public
    // demo search), fail open on the owner-gated one (places_request) —
    // an owner hitting a transient DB error shouldn't be locked out of
    // search, but an anonymous visitor shouldn't get an unmetered Google
    // call just because the usage table had a hiccup.
    if (kind === "maps_js_load" || kind === "public_places_request") {
      return { admitted: false, count: allowance, allowance };
    }
    return { admitted: true, count: 0, allowance };
  }

  if ((currentCount ?? 0) >= allowance) {
    return { admitted: false, count: currentCount ?? 0, allowance };
  }

  const { data: newCount, error: incrementError } = await supabase.rpc(
    "increment_google_api_usage",
    { p_kind: kind },
  );
  if (incrementError) {
    return { admitted: true, count: (currentCount ?? 0) + 1, allowance };
  }

  return { admitted: true, count: newCount ?? (currentCount ?? 0) + 1, allowance };
}
