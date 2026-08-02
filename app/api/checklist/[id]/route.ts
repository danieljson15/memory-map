import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { UpdateChecklistItemInput } from "@/shared/api-types";

interface RouteParams {
  params: Promise<{ id: string }>;
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

  const body = (await request.json()) as UpdateChecklistItemInput;
  const updates: Record<string, string | boolean> = {};

  if (body.text !== undefined) {
    if (!body.text.trim()) {
      return NextResponse.json(
        { error: "text cannot be empty" },
        { status: 400 },
      );
    }
    updates.text = body.text.trim();
  }
  if (body.is_done !== undefined) updates.is_done = body.is_done;

  const { data, error } = await supabase
    .from("checklist_items")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ item: data });
}
