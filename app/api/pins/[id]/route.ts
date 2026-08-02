import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { PinWithPhotos, UpdatePinInput } from "@/shared/api-types";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("pins")
    .select("*, photos:pin_photos(*)")
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

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const body = (await request.json()) as UpdatePinInput;
  const updates: Record<string, string> = {};

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
    updates.note = body.note.trim();
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

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const { error } = await supabase.from("pins").delete().eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
