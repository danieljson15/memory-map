import { NextRequest, NextResponse } from "next/server";
import { getOwnerAccess } from "@/lib/api-auth";
import { autocompletePlaces } from "@/lib/google-places";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { admitGoogleApiUsage } from "@/lib/usage";
import type { PlaceAutocompleteInput } from "@/shared/api-types";

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const access = await getOwnerAccess(supabase);
  if (!access.user) {
    return NextResponse.json({ error: access.error }, { status: access.status });
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
  const usage = await admitGoogleApiUsage(supabase, "places_request");
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
    const message = error instanceof Error ? error.message : "Autocomplete failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
