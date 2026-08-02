import { createClient } from "@supabase/supabase-js";

// Falls back to placeholder values so `next build` always succeeds even
// before real Supabase credentials are set. The app will show real errors
// at runtime (e.g. failed sign-in) until .env.local has real values —
// see README.md for setup steps.
const supabaseUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co";
const supabaseAnonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "placeholder-anon-key";

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
