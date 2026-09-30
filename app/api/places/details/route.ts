import { NextRequest, NextResponse } from "next/server";
import { getOwnerAccess } from "@/lib/api-auth";
import { getPlaceDetails } from "@/lib/google-places";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { admitGoogleApiUsage, UsageLimitError } from "@/lib/usage";

export async function GET(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const access = await getOwnerAccess(supabase);
  if (!access.user) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const placeId = request.nextUrl.searchParams.get("place_id")?.trim();
  const sessionToken = request.nextUrl.searchParams
    .get("session_token")
    ?.trim();
  if (!placeId || placeId.length > 512) {
    return NextResponse.json({ error: "place_id is required" }, { status: 400 });
  }

  try {
    // The usage gate only runs on an actual cache miss (see
    // lib/google-places.ts) — a cached lookup costs nothing, so it
    // shouldn't be blocked by, or count against, the monthly allowance.
    const place = await getPlaceDetails(supabase, placeId, sessionToken, async () => {
      const usage = await admitGoogleApiUsage(supabase, "places_request");
      return usage.admitted;
    });
    return NextResponse.json({ place });
  } catch (error) {
    if (error instanceof UsageLimitError) {
      return NextResponse.json(
        {
          error:
            "Google Places usage limit reached for this month. Search will be back next month.",
        },
        { status: 503 },
      );
    }
    // Not error.message — it can carry Google's raw response body (see
    // lib/google-places.ts), which shouldn't reach the client even though
    // this route is owner-gated.
    console.error("Place details lookup failed:", error);
    return NextResponse.json({ error: "Place lookup failed" }, { status: 502 });
  }
}
