import { cookies } from "next/headers";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

// Used inside API route handlers only. Reads the caller's session from
// cookies so every query runs as that authenticated user — RLS policies
// apply exactly as they would from the browser client, nothing is
// bypassed here.
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "placeholder-anon-key",
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(
          cookiesToSet: {
            name: string;
            value: string;
            options: CookieOptions;
          }[],
        ) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a Server Component context where cookies can't
            // be written — safe to ignore since middleware (if added
            // later) handles session refresh in that case.
          }
        },
      },
    },
  );
}
