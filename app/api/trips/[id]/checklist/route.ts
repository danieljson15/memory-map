import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { CreateChecklistItemInput } from "@/shared/api-types";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: tripId } = await params;
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const body = (await request.json()) as CreateChecklistItemInput;

  if (!body.text?.trim()) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("checklist_items")
    .insert({
      trip_id: tripId,
      text: body.text.trim(),
      created_by: user.id,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ item: data }, { status: 201 });
}
