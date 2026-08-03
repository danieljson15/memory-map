import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { RankedWishlistPin } from "@/shared/api-types";

// Public read, same as pins themselves — this is a ranking over
// already-public data, not a write, so no auth check here.
export async function GET(request: NextRequest) {
  const supabase = await createSupabaseServerClient();

  const matchCountParam = request.nextUrl.searchParams.get("limit");
  const matchCount = matchCountParam ? parseInt(matchCountParam, 10) : 10;

  const { data, error } = await supabase.rpc("rank_wishlist_by_taste", {
    match_count: matchCount,
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
