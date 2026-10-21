import { NextRequest, NextResponse } from "next/server";
import { getOwnerAccess } from "@/lib/api-auth";
import { autocompletePlaces } from "@/lib/google-places";
import { checkRateLimit, clientIdentifier } from "@/lib/rate-limit";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { admitGoogleApiUsage } from "@/lib/usage";
import type { PlaceAutocompleteInput } from "@/shared/api-types";

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  // Public by design: anyone can search the map. Searching only pans the
  // map — saving a place as a pin is still owner-only (POST /api/pins).
  // Owners use their own allowance; public callers are rate limited per
  // client and metered on a separate, smaller monthly counter so anonymous
  // searches can't eat the owners' budget or the nearby demo's.
  const access = await getOwnerAccess(supabase);
  const isOwner = !!access.user;

  if (!isOwner) {
    const rateLimit = await checkRateLimit(
      supabase,
      "PUBLIC_SEARCH",
      clientIdentifier(request),
    );
    if (!rateLimit.admitted) {
      return NextResponse.json(
        { error: "Too many searches — try again later." },
        {
          status: 429,
          headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
        },
      );
    }
  }

  let body: PlaceAutocompleteInput;
  try {
    body = (await request.json()) as PlaceAutocompleteInput;
  } catch {
    // A request whose body got cut short (e.g. the browser aborted an
    // in-flight search on the next keystroke before the body finished
    // sending) lands here as an empty/truncated body — a normal race,
    // not a real error, so it gets a clean 400 instead of an unhandled
    // JSON.parse throw.
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const input = body.input?.trim();
  if (
    !input ||
    input.length < 3 ||
    input.length > 200 ||
    !body.session_token?.trim() ||
    body.session_token.length > 100
  ) {
    return NextResponse.json(
      { error: "input must be 3-200 characters and session_token is required" },
      { status: 400 },
    );
  }

  const bias = body.location_bias;
  const hasValidBias =
    bias &&
    Number.isFinite(bias.lat) &&
    Number.isFinite(bias.lng) &&
    bias.lat >= -90 &&
    bias.lat <= 90 &&
    bias.lng >= -180 &&
    bias.lng <= 180;

  // Checked (and counted) only once the request is well-formed, so a
  // malformed call never spends usage quota for nothing.
  const usage = await admitGoogleApiUsage(
    supabase,
    isOwner ? "places_request" : "public_search_request",
  );
  if (!usage.admitted) {
    return NextResponse.json(
      {
        error:
          "Google Places usage limit reached for this month. Search will be back next month.",
      },
      { status: 503 },
    );
  }

  try {
    const predictions = await autocompletePlaces({
      query: input,
      sessionToken: body.session_token,
      locationBias: hasValidBias
        ? {
            lat: bias.lat,
            lng: bias.lng,
            radiusMeters: Math.min(
              50_000,
              Math.max(100, bias.radius_meters ?? 20_000),
            ),
          }
        : undefined,
    });
    return NextResponse.json({ predictions });
  } catch (error) {
    // Not error.message — it can carry Google's raw response body (see
    // lib/google-places.ts), which shouldn't reach the client.
    console.error("Autocomplete failed:", error);
    return NextResponse.json({ error: "Autocomplete failed" }, { status: 502 });
  }
}
