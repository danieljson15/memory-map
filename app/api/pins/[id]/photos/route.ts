import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { RegisterPhotoInput } from "@/shared/api-types";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// The photo bytes are already in storage by the time this is called —
// the browser uploads directly to Supabase Storage first (bypassing this
// API entirely, per the frontend brief), then calls this route with the
// resulting path so the backend can record it against the pin.
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: pinId } = await params;
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const body = (await request.json()) as RegisterPhotoInput;

  if (!body.storage_path?.trim()) {
    return NextResponse.json(
      { error: "storage_path is required" },
      { status: 400 },
    );
  }

  const { data, error } = await supabase
    .from("pin_photos")
    .insert({
      pin_id: pinId,
      storage_path: body.storage_path,
      created_by: user.id,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ photo: data }, { status: 201 });
}
