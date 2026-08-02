import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { CreateTripInput } from "@/shared/api-types";

export async function GET() {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("trips")
    .select("*")
    .order("start_date", { ascending: true, nullsFirst: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ trips: data });
}

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const body = (await request.json()) as CreateTripInput;

  if (!body.title?.trim()) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("trips")
    .insert({
      title: body.title.trim(),
      start_date: body.start_date || null,
      end_date: body.end_date || null,
      created_by: user.id,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ trip: data }, { status: 201 });
}
