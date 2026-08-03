import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { runSuggester, type SuggesterCandidate } from "@/lib/suggester";
import type { RunSuggesterInput } from "@/shared/api-types";

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const body = (await request.json()) as RunSuggesterInput;

  if (
    typeof body.budget !== "number" ||
    !body.departure_airport?.trim() ||
    !body.travel_month?.trim() ||
    typeof body.nights !== "number"
  ) {
    return NextResponse.json(
      { error: "budget, departure_airport, travel_month, and nights are all required" },
      { status: 400 },
    );
  }

  // Step 1: pull real ranked candidates from the embeddings work, and
  // the actual memory-pin history for taste context in the prompt.
  const { data: ranked, error: rankError } = await supabase.rpc(
    "rank_wishlist_by_taste",
    { match_count: 5 },
  );

  if (rankError) {
    return NextResponse.json({ error: rankError.message }, { status: 500 });
  }

  const { data: memoryPins, error: memoryError } = await supabase
    .from("pins")
    .select("title, note")
    .eq("kind", "memory")
    .not("embedding", "is", null);

  if (memoryError) {
    return NextResponse.json({ error: memoryError.message }, { status: 500 });
  }

  // Only a hard stop if there's truly nothing to reason from — no travel
  // history at all. An empty wishlist alone is fine now: the model can
  // still propose something new based on taste + budget.
  if (!memoryPins || memoryPins.length === 0) {
    return NextResponse.json(
      {
        error:
          "No memory pins with embeddings yet — add some memories and run the embedding backfill before running the suggester.",
      },
      { status: 422 },
    );
  }

  const candidates: SuggesterCandidate[] = (ranked || []).map(
    (r: { title: string; note: string | null; similarity: number }) => ({
      title: r.title,
      note: r.note,
      similarity: r.similarity,
    }),
  );

  // Step 2: the actual LLM reasoning step.
  let suggesterResult;
  try {
    suggesterResult = await runSuggester({
      budget: body.budget,
      departureAirport: body.departure_airport,
      travelMonth: body.travel_month,
      nights: body.nights,
      candidates,
      memories: memoryPins,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Suggester failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  // Step 3: persist. Insert restricted to the two owner accounts by the
  // "Only owners can insert suggestions" RLS policy — a non-owner
  // authenticated user hitting this route fails here, not silently.
  const { data: suggestion, error: insertError } = await supabase
    .from("suggestions")
    .insert({
      status: "complete",
      budget: body.budget,
      departure_airport: body.departure_airport,
      travel_month: body.travel_month,
      nights: body.nights,
      destination: suggesterResult.destination,
      cost_breakdown: suggesterResult.costBreakdown,
      total_cost: suggesterResult.totalCost,
      created_by: user.id,
      completed_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (insertError) {
    if (insertError.code === "42501") {
      return NextResponse.json(
        { error: "Only the two owner accounts can run the suggester." },
        { status: 403 },
      );
    }
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  const stepRows = suggesterResult.steps.map((text, index) => ({
    suggestion_id: suggestion.id,
    step_order: index + 1,
    kind: "text" as const,
    content: { text },
  }));

  const { data: steps, error: stepsError } = await supabase
    .from("suggestion_steps")
    .insert(stepRows)
    .select();

  // `ranked` (the raw rank_wishlist_by_taste output, richer than the
  // `candidates` shape passed into the prompt — it still has id/lat/lng)
  // goes back to the client as-is so the UI can actually show the
  // embeddings-driven ranking it was based on, not just the LLM's prose
  // description of it.
  if (stepsError) {
    // The suggestion itself saved fine; the steps are supplementary.
    // Return what we have rather than treating this as a full failure.
    console.error("Failed to persist suggestion steps:", stepsError);
    return NextResponse.json(
      { suggestion, steps: [], candidates: ranked },
      { status: 201 },
    );
  }

  return NextResponse.json(
    { suggestion, steps, candidates: ranked },
    { status: 201 },
  );
}
