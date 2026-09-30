import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getOwnerAccess } from "@/lib/api-auth";

interface RouteParams {
  params: Promise<{ id: string; photoId: string }>;
}

// Needed for pin editing (replacing or removing the one photo the UI
// currently supports) — there was previously no way to remove a
// pin_photos row at all, only to add one.
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  const { id: pinId, photoId } = await params;
  const supabase = await createSupabaseServerClient();

  const access = await getOwnerAccess(supabase);
  if (!access.user) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const { data: photo, error: fetchError } = await supabase
    .from("pin_photos")
    .select("storage_path")
    .eq("id", photoId)
    .eq("pin_id", pinId)
    .single();

  if (fetchError || !photo) {
    return NextResponse.json({ error: "Photo not found" }, { status: 404 });
  }

  const { error: deleteError } = await supabase
    .from("pin_photos")
    .delete()
    .eq("id", photoId);

  if (deleteError) {
    return NextResponse.json({ error: deleteError.message }, { status: 500 });
  }

  const { error: storageError } = await supabase.storage
    .from("photos")
    .remove([photo.storage_path]);
  if (storageError) {
    // The row is gone either way — a dangling storage object costs
    // nothing to leave behind and shouldn't fail the request the user
    // is waiting on.
    console.error("Photo row deleted but storage object could not be removed:", storageError);
  }

  return NextResponse.json({ success: true });
}
