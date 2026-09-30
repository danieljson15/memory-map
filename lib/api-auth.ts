import type { SupabaseClient, User } from "@supabase/supabase-js";

export interface OwnerAccessResult {
  user: User | null;
  error: string | null;
  status: number;
}

// Checks authorization before any metered external API call. RLS remains the
// final database boundary, but doing this first prevents non-owners from
// consuming Google Places, Voyage, or Groq quota and only failing on insert.
export async function getOwnerAccess(
  supabase: SupabaseClient,
): Promise<OwnerAccessResult> {
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return { user: null, error: "Not signed in", status: 401 };
  }

  const { data: isOwner, error: ownerError } = await supabase.rpc(
    "is_memory_map_owner",
  );

  if (ownerError) {
    return {
      user: null,
      error: `Owner policy check failed: ${ownerError.message}`,
      status: 500,
    };
  }

  if (!isOwner) {
    return {
      user: null,
      error: "Only the two owner accounts can make changes.",
      status: 403,
    };
  }

  return { user, error: null, status: 200 };
}
