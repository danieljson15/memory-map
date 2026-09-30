import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isPriceTier } from "@/lib/budget";
import type { RankedWishlistPin } from "@/shared/api-types";

// Public read, same as pins themselves — this is a ranking over
// already-public data, not a write, so no auth check here.
export async function GET(request: NextRequest) {
  const supabase = await createSupabaseServerClient();

  const matchCountParam = request.nextUrl.searchParams.get("limit");
  const matchCount = matchCountParam ? parseInt(matchCountParam, 10) : 10;
  if (!Number.isInteger(matchCount) || matchCount < 1 || matchCount > 50) {
    return NextResponse.json(
      { error: "limit must be an integer from 1 to 50" },
      { status: 400 },
    );
  }

  const params = request.nextUrl.searchParams;
  const keyword = params.get("q")?.trim() || null;
  if (keyword && keyword.length > 200) {
    return NextResponse.json({ error: "q must be 200 characters or fewer" }, { status: 400 });
  }
  const num = (name: string) => {
    const raw = params.get(name);
    return raw === null || raw === "" ? null : Number(raw);
  };
  const lat = num("lat");
  const lng = num("lng");
  const radiusKm = num("radius_km");
  const maxTier = num("max_price_tier");
  const invalid =
    (lat !== null && !(Number.isFinite(lat) && lat >= -90 && lat <= 90)) ||
    (lng !== null && !(Number.isFinite(lng) && lng >= -180 && lng <= 180)) ||
    (radiusKm !== null && !(Number.isFinite(radiusKm) && radiusKm >= 1 && radiusKm <= 20_000)) ||
    (maxTier !== null && !isPriceTier(maxTier));
  if (invalid) {
    return NextResponse.json(
      { error: "lat, lng, radius_km, or max_price_tier is out of range" },
      { status: 400 },
    );
  }
  // The location constraint needs all three; a partial one is ignored by
  // the SQL function rather than half-applied.
  const { data, error } = await supabase.rpc("rank_wishlist_hybrid", {
    match_count: matchCount,
    keyword_query: keyword,
    center_lat: lat,
    center_lng: lng,
    radius_km: radiusKm,
    max_price_tier: maxTier,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Empty isn't an error — it means no memory pins have embeddings yet
  // (nothing to build a taste vector from). Let the frontend distinguish
  // "no data yet" from a real failure.
  return NextResponse.json({
    ranked: data as RankedWishlistPin[],
    has_taste_data: (data as RankedWishlistPin[]).length > 0,
  });
}
