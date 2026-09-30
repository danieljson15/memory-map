import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getOwnerAccess } from "@/lib/api-auth";
import { isPriceTier } from "@/lib/budget";
import { getEmbedding, pinTextForEmbedding } from "@/lib/embeddings";
import { checkRateLimit, clientIdentifier } from "@/lib/rate-limit";
import type {
  CreatePinInput,
  PinKind,
  PinWithPhotos,
} from "@/shared/api-types";

export async function GET(request: NextRequest) {
  const supabase = await createSupabaseServerClient();

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

  const kind = request.nextUrl.searchParams.get("kind") as PinKind | null;

  if (kind && kind !== "memory" && kind !== "wishlist") {
    return NextResponse.json(
      { error: "kind must be 'memory' or 'wishlist'" },
      { status: 400 },
    );
  }

  let query = supabase
    .from("pins")
    .select(
      "id, kind, lat, lng, title, note, place_provider, external_place_id, user_rating, tags, price_tier, created_by, created_at, updated_at, photos:pin_photos(*)",
    )
    .order("created_at", { ascending: false });

  if (kind) {
    query = query.eq("kind", kind);
  }

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ pins: data as PinWithPhotos[] });
}

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const access = await getOwnerAccess(supabase);
  if (!access.user) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }
  const user = access.user;

  const body = (await request.json()) as CreatePinInput;

  if (!body.title?.trim()) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }
  if (body.kind !== "memory" && body.kind !== "wishlist") {
    return NextResponse.json(
      { error: "kind must be 'memory' or 'wishlist'" },
      { status: 400 },
    );
  }
  if (typeof body.lat !== "number" || typeof body.lng !== "number") {
    return NextResponse.json(
      { error: "lat and lng are required numbers" },
      { status: 400 },
    );
  }
  if (
    !Number.isFinite(body.lat) ||
    !Number.isFinite(body.lng) ||
    body.lat < -90 ||
    body.lat > 90 ||
    body.lng < -180 ||
    body.lng > 180
  ) {
    return NextResponse.json(
      { error: "lat and lng must be valid coordinates" },
      { status: 400 },
    );
  }
  const hasProvider = !!body.place_provider;
  const hasExternalId = !!body.external_place_id?.trim();
  if (hasProvider !== hasExternalId || (hasProvider && body.place_provider !== "google")) {
    return NextResponse.json(
      { error: "place_provider and external_place_id must be supplied together" },
      { status: 400 },
    );
  }
  if (
    body.user_rating !== undefined &&
    (!Number.isInteger(body.user_rating) ||
      body.user_rating < 1 ||
      body.user_rating > 5)
  ) {
    return NextResponse.json(
      { error: "user_rating must be an integer from 1 to 5" },
      { status: 400 },
    );
  }
  if (body.price_tier !== undefined && !isPriceTier(body.price_tier)) {
    return NextResponse.json(
      { error: "price_tier must be an integer from 1 to 4" },
      { status: 400 },
    );
  }
  if (
    body.tags !== undefined &&
    (!Array.isArray(body.tags) ||
      body.tags.some((tag) => typeof tag !== "string"))
  ) {
    return NextResponse.json(
      { error: "tags must be an array of strings" },
      { status: 400 },
    );
  }
  const tags = [...new Set((body.tags ?? []).map((tag) => tag.trim()).filter(Boolean))]
    .slice(0, 10)
    .map((tag) => tag.slice(0, 40));

  let embedding: number[] | null = null;
  try {
    const text = pinTextForEmbedding(
      body.title.trim(),
      body.note?.trim() || null,
      tags,
    );
    embedding = await getEmbedding(supabase, text, "document");
  } catch (err) {
    // Don't let an embeddings outage block pin creation — the pin still
    // saves with a null embedding and can be backfilled later. Log it
    // rather than silently swallowing it.
    console.error("Embedding generation failed for new pin:", err);
  }

  const { data, error } = await supabase
    .from("pins")
    .insert({
      kind: body.kind,
      lat: body.lat,
      lng: body.lng,
      title: body.title.trim(),
      note: body.note?.trim() || null,
      embedding,
      place_provider: body.place_provider ?? null,
      external_place_id: body.external_place_id?.trim() || null,
      user_rating: body.user_rating ?? null,
      tags,
      price_tier: body.price_tier ?? null,
      created_by: user.id,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ pin: data }, { status: 201 });
}
