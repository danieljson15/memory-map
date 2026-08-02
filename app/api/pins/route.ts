import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getEmbedding, pinTextForEmbedding } from "@/lib/embeddings";
import type {
  CreatePinInput,
  PinKind,
  PinWithPhotos,
} from "@/shared/api-types";

export async function GET(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const kind = request.nextUrl.searchParams.get("kind") as PinKind | null;

  if (kind && kind !== "memory" && kind !== "wishlist") {
    return NextResponse.json(
      { error: "kind must be 'memory' or 'wishlist'" },
      { status: 400 },
    );
  }

  let query = supabase
    .from("pins")
    .select("*, photos:pin_photos(*)")
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

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

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

  let embedding: number[] | null = null;
  try {
    const text = pinTextForEmbedding(body.title.trim(), body.note?.trim() || null);
    embedding = await getEmbedding(text, "document");
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
      created_by: user.id,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ pin: data }, { status: 201 });
}
