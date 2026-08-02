// One-off / periodic maintenance script — not part of the running app.
//
// Why this needs to exist as a separate script right now: the current
// frontend inserts pins via a direct supabase.from('pins').insert() call
// (see MapView.tsx / PinModal.tsx), not through the /api/pins route, so
// the embedding-on-create logic in that route never actually runs for
// pins created through the app today. This script is the practical
// workaround — run it after adding pins to backfill their embeddings.
//
// The longer-term fix, once the frontend routes through the API layer
// (or via a Supabase Database Webhook + Edge Function triggered on
// insert), is to generate the embedding automatically at write time and
// retire this script. Noting that rather than pretending this is the
// permanent design.
//
// Run with: npm run embed:backfill

import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { getEmbedding, pinTextForEmbedding } from "../lib/embeddings";

async function main() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be " +
        "set in .env.local. The service role key bypasses RLS — get it " +
        "from Supabase: Project Settings -> API -> service_role key. " +
        "Never prefix it with NEXT_PUBLIC_ or it ships to the browser.",
    );
  }

  // Service role client — intentionally bypasses RLS. This script is
  // trusted server-side maintenance, never run in the browser.
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const { data: pins, error } = await supabase
    .from("pins")
    .select("id, title, note")
    .is("embedding", null);

  if (error) {
    throw new Error(`Failed to fetch pins: ${error.message}`);
  }

  if (!pins || pins.length === 0) {
    console.log("No pins missing embeddings. Nothing to do.");
    return;
  }

  console.log(`Found ${pins.length} pin(s) missing embeddings. Generating...`);

  let succeeded = 0;
  let failed = 0;

  for (const pin of pins) {
    try {
      const text = pinTextForEmbedding(pin.title, pin.note);
      const embedding = await getEmbedding(text, "document");

      const { error: updateError } = await supabase
        .from("pins")
        .update({ embedding })
        .eq("id", pin.id);

      if (updateError) throw updateError;

      succeeded++;
      console.log(`  ✓ ${pin.title}`);
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ ${pin.title}: ${message}`);
    }
  }

  console.log(`\nDone: ${succeeded} succeeded, ${failed} failed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
