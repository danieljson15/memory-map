import { createBrowserClient } from "@supabase/ssr";

// Falls back to placeholder values so `next build` always succeeds even
// before real Supabase credentials are set. The app will show real errors
// at runtime (e.g. failed sign-in) until .env.local has real values —
// see README.md for setup steps.
const supabaseUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co";
const supabaseAnonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "placeholder-anon-key";

// @supabase/ssr's browser client (not plain @supabase/supabase-js
// createClient) — it persists the session to cookies rather than only
// localStorage, which is what lets the /api/* route handlers (via
// lib/supabase/server.ts's createServerClient, which reads the same
// cookies) see the signed-in user at all. Without this, every API route
// would see every request as signed out regardless of browser auth state,
// since no session data would ever reach the server. Same public API
// surface as plain createClient otherwise — nothing else in the app needs
// to change for this swap.
export const supabase = createBrowserClient(supabaseUrl, supabaseAnonKey);
