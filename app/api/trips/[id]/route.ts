import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { UpdateTripInput } from "@/shared/api-types";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("trips")
    .select("*, checklist:checklist_items(*)")
    .eq("id", id)
    .single();

  if (error) {
    return NextResponse.json({ error: "Trip not found" }, { status: 404 });
  }

  return NextResponse.json({ trip: data });
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

  const body = (await request.json()) as UpdateTripInput;
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
  if (body.start_date !== undefined) updates.start_date = body.start_date;
  if (body.end_date !== undefined) updates.end_date = body.end_date;

  const { data, error } = await supabase
    .from("trips")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ trip: data });
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

  const { error } = await supabase.from("trips").delete().eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
