import { NextRequest, NextResponse } from "next/server";
import { getOwnerAccess } from "@/lib/api-auth";
import { getEmbedding, getEmbeddings } from "@/lib/embeddings";
import { searchNearbyPlaces } from "@/lib/google-places";
import { isPriceTier, priceTierFromGoogleLevel, withinPriceTier } from "@/lib/budget";
import { rankNearbyCandidates } from "@/lib/recommendations";
import { checkRateLimit, clientIdentifier } from "@/lib/rate-limit";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { admitGoogleApiUsage, UsageLimitError } from "@/lib/usage";
import type { NearbyRecommendationsInput } from "@/shared/api-types";

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();

  // Public by design — anyone can try the recommender. Only saving a
  // result as a pin (POST /api/pins) is still owner-only. Since this
  // triggers real, billable Google Nearby Search calls, public callers
  // are both rate-limited per-client and metered on a separate, much
  // smaller monthly counter (public_places_request) so a spike in demo
  // traffic can't eat the owners' own search allowance.
  const access = await getOwnerAccess(supabase);
  const isOwner = !!access.user;
  const usageKind = isOwner ? "places_request" : "public_places_request";

  if (!isOwner) {
    const rateLimit = await checkRateLimit(
      supabase,
      "PUBLIC_NEARBY",
      clientIdentifier(request),
    );
    if (!rateLimit.admitted) {
      return NextResponse.json(
        { error: "Too many requests — try again later." },
        {
          status: 429,
          headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
        },
      );
    }
  }

  const body = (await request.json()) as NearbyRecommendationsInput;
  if (
    !Number.isFinite(body.lat) ||
    !Number.isFinite(body.lng) ||
    body.lat < -90 ||
    body.lat > 90 ||
    body.lng < -180 ||
    body.lng > 180
  ) {
    return NextResponse.json(
      { error: "Valid lat and lng values are required" },
      { status: 400 },
    );
  }
  if (body.max_price_tier !== undefined && !isPriceTier(body.max_price_tier)) {
    return NextResponse.json(
      { error: "max_price_tier must be an integer from 1 to 4" },
      { status: 400 },
    );
  }
  const maxPriceTier = body.max_price_tier;
  const radiusMeters = Math.min(
    50_000,
    Math.max(
      500,
      typeof body.radius_meters === "number" && Number.isFinite(body.radius_meters)
        ? body.radius_meters
        : 8_000,
    ),
  );

  const [{ data: memories, error: memoriesError }, { data: savedPlaces }] =
    await Promise.all([
      supabase
        .from("pins")
        .select("title, note, user_rating, tags")
        .eq("kind", "memory"),
      supabase
        .from("pins")
        .select("external_place_id")
        .not("external_place_id", "is", null),
    ]);

  if (memoriesError) {
    return NextResponse.json({ error: memoriesError.message }, { status: 500 });
  }
  if (!memories?.length) {
    return NextResponse.json(
      { error: "Add at least one memory before requesting recommendations." },
      { status: 422 },
    );
  }

  try {
    const positiveMemories = memories.filter(
      (memory) => memory.user_rating === null || memory.user_rating >= 3,
    );
    const negativeMemories = memories.filter(
      (memory) => memory.user_rating !== null && memory.user_rating < 3,
    );
    if (positiveMemories.length === 0) {
      return NextResponse.json(
        { error: "Rate at least one memory 3 stars or higher to build a positive taste profile." },
        { status: 422 },
      );
    }
    const savedIds = new Set(
      (savedPlaces ?? []).flatMap((pin) =>
        pin.external_place_id ? [pin.external_place_id] : [],
      ),
    );

    // The usage gate only runs on an actual cache miss inside
    // searchNearbyPlaces — a cached result costs nothing, so it
    // shouldn't be blocked by, or count against, the monthly allowance.
    // When it does run, it's counted as one places_request even though
    // searchNearbyPlaces makes three parallel Google calls internally
    // (one per category group) — this counter is an early-warning
    // breaker, not a precise billing meter, and the real hard cap is
    // the Google Cloud Console quota.
    const candidates = (
      await searchNearbyPlaces(
        supabase,
        { lat: body.lat, lng: body.lng, radiusMeters },
        async () => {
          const usage = await admitGoogleApiUsage(supabase, usageKind);
          return usage.admitted;
        },
      )
    )
      .filter((candidate) => !savedIds.has(candidate.place_id))
      // Budget constraint, applied before embedding so filtered-out
      // candidates never cost a Voyage request. The cached Google result
      // stays unfiltered so a different budget can reuse it.
      .filter((candidate) =>
        withinPriceTier(priceTierFromGoogleLevel(candidate.price_level), maxPriceTier),
      );

    if (candidates.length === 0) {
      return NextResponse.json({ recommendations: [] });
    }

    const memoriesToText = (items: typeof memories, includeRating: boolean) => items
      .map((memory) => {
        const rating = includeRating && memory.user_rating
          ? `Personal rating: ${memory.user_rating}/5.`
          : "";
        const tags = memory.tags?.length
          ? `Tags: ${memory.tags.join(", ")}.`
          : "";
        return [memory.title, memory.note, rating, tags].filter(Boolean).join("\n");
      })
      .join("\n\n");
    const tasteText = memoriesToText(positiveMemories, true);
    const avoidanceText = memoriesToText(negativeMemories, false);
    const candidateTexts = candidates.map((candidate) =>
      [
        candidate.name,
        candidate.primary_type?.replaceAll("_", " "),
        candidate.types.map((type) => type.replaceAll("_", " ")).join(", "),
      ]
        .filter(Boolean)
        .join("\n"),
    );

    const [tasteEmbedding, candidateEmbeddings, avoidanceEmbedding] =
      await Promise.all([
      getEmbedding(supabase, tasteText, "query"),
      getEmbeddings(supabase, candidateTexts, "document"),
      avoidanceText
        ? getEmbedding(supabase, avoidanceText, "query")
        : Promise.resolve(undefined),
    ]);

    const recommendations = rankNearbyCandidates({
      candidates,
      candidateEmbeddings,
      tasteEmbedding,
      avoidanceEmbedding,
      center: { lat: body.lat, lng: body.lng },
      radiusMeters,
    });
    return NextResponse.json({ recommendations });
  } catch (error) {
    if (error instanceof UsageLimitError) {
      return NextResponse.json(
        {
          error:
            "Google Places usage limit reached for this month. Recommendations will be back next month.",
        },
        { status: 503 },
      );
    }
    // Not error.message — it can carry Google's raw response body (see
    // lib/google-places.ts), which shouldn't reach the client even though
    // this route is owner-gated.
    console.error("Recommendation search failed:", error);
    return NextResponse.json(
      { error: "Recommendation search failed" },
      { status: 502 },
    );
  }
}
