import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isPriceTier } from "@/lib/budget";
import { getOwnerAccess } from "@/lib/api-auth";
import { getEmbedding, pinTextForEmbedding } from "@/lib/embeddings";
import type { PinWithPhotos, UpdatePinInput } from "@/shared/api-types";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("pins")
    .select(
      "id, kind, lat, lng, title, note, place_provider, external_place_id, user_rating, tags, price_tier, created_by, created_at, updated_at, photos:pin_photos(*)",
    )
    .eq("id", id)
    .single();

  if (error) {
    return NextResponse.json({ error: "Pin not found" }, { status: 404 });
  }

  return NextResponse.json({ pin: data as PinWithPhotos });
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();

  const access = await getOwnerAccess(supabase);
  if (!access.user) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const body = (await request.json()) as UpdatePinInput;
  const updates: Record<
    string,
    string | string[] | number | number[] | null
  > = {};

  if (body.kind !== undefined) {
    if (body.kind !== "memory" && body.kind !== "wishlist") {
      return NextResponse.json(
        { error: "kind must be 'memory' or 'wishlist'" },
        { status: 400 },
      );
    }
    updates.kind = body.kind;
  }
  if (body.title !== undefined) {
    if (!body.title.trim()) {
      return NextResponse.json(
        { error: "title cannot be empty" },
        { status: 400 },
      );
    }
    updates.title = body.title.trim();
  }
  if (body.note !== undefined) {
    updates.note = body.note.trim() || null;
  }
  if (body.user_rating !== undefined) {
    if (
      body.user_rating !== null &&
      (!Number.isInteger(body.user_rating) ||
        body.user_rating < 1 ||
        body.user_rating > 5)
    ) {
      return NextResponse.json(
        { error: "user_rating must be null or an integer from 1 to 5" },
        { status: 400 },
      );
    }
    updates.user_rating = body.user_rating;
  }
  if (body.price_tier !== undefined) {
    if (body.price_tier !== null && !isPriceTier(body.price_tier)) {
      return NextResponse.json(
        { error: "price_tier must be null or an integer from 1 to 4" },
        { status: 400 },
      );
    }
    updates.price_tier = body.price_tier;
  }
  if (body.tags !== undefined) {
    if (
      !Array.isArray(body.tags) ||
      body.tags.some((tag) => typeof tag !== "string")
    ) {
      return NextResponse.json(
        { error: "tags must be an array of strings" },
        { status: 400 },
      );
    }
    updates.tags = [...new Set(body.tags.map((tag) => tag.trim()).filter(Boolean))]
      .slice(0, 10)
      .map((tag) => tag.slice(0, 40));
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No supported updates supplied" }, { status: 400 });
  }

  // Title/note changes alter the semantic document, so keep the stored
  // embedding synchronized instead of silently ranking stale text.
  if (body.title !== undefined || body.note !== undefined || body.tags !== undefined) {
    const { data: current, error: currentError } = await supabase
      .from("pins")
      .select("title, note, tags")
      .eq("id", id)
      .single();
    if (currentError) {
      return NextResponse.json({ error: "Pin not found" }, { status: 404 });
    }
    try {
      updates.embedding = await getEmbedding(
        supabase,
        pinTextForEmbedding(
          (updates.title as string | undefined) ?? current.title,
          updates.note !== undefined
            ? (updates.note as string | null)
            : current.note,
          (updates.tags as string[] | undefined) ?? current.tags,
        ),
        "document",
      );
    } catch (error) {
      console.error("Embedding regeneration failed while updating pin:", error);
      updates.embedding = null;
    }
  }

  const { data, error } = await supabase
    .from("pins")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ pin: data });
}

export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();

  const access = await getOwnerAccess(supabase);
  if (!access.user) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const { data: photos } = await supabase
    .from("pin_photos")
    .select("storage_path")
    .eq("pin_id", id);

  const { error } = await supabase.from("pins").delete().eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const storagePaths = (photos ?? []).map((photo) => photo.storage_path);
  if (storagePaths.length > 0) {
    const { error: storageError } = await supabase.storage
      .from("photos")
      .remove(storagePaths);
    if (storageError) {
      console.error("Pin deleted but its storage objects could not be removed:", storageError);
    }
  }

  return NextResponse.json({ success: true });
}
