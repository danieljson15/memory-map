import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { admitGoogleApiUsage } from "@/lib/usage";
import { checkRateLimit, clientIdentifier } from "@/lib/rate-limit";
import type { MapsConfigResponse } from "@/shared/api-types";

// Public, no owner gate — every visitor loading the map calls this
// before MapView requests the Google Maps JS SDK at all, so an
// over-allowance visitor never triggers a billable load in the first
// place. This is the actual usage control; a Cloud Console quota or
// budget alert is only a backstop behind it.
export async function GET(request: NextRequest) {
  const supabase = await createSupabaseServerClient();

  // A per-minute throttle in front of the monthly usage cap below — without
  // it, one client rapidly polling this route could burn the whole month's
  // maps_js_load allowance by itself and degrade the map to Leaflet for
  // every other visitor.
  const rateLimit = await checkRateLimit(
    supabase,
    "PUBLIC_READ",
    clientIdentifier(request),
  );
  if (!rateLimit.admitted) {
    return NextResponse.json(
      { error: "Too many requests" },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      },
    );
  }

  const admission = await admitGoogleApiUsage(supabase, "maps_js_load");

  return NextResponse.json({
    provider: admission.admitted ? "google" : "leaflet",
  } satisfies MapsConfigResponse);
}
