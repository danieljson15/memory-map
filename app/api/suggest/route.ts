import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getOwnerAccess } from "@/lib/api-auth";
import { maxPriceTierForBudget } from "@/lib/budget";
import { checkRateLimit, clientIdentifier } from "@/lib/rate-limit";
import {
  BudgetExceededError,
  runSuggesterWithinBudget,
  type SuggesterCandidate,
} from "@/lib/suggester";
import type {
  AppliedConstraints,
  RankedWishlistPin,
  RunSuggesterInput,
  Suggestion,
  SuggestionStep,
} from "@/shared/api-types";

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();

  // Public by design (unlike pin writes) — anyone can try the suggester.
  // Owners get their run persisted to suggestion history as before;
  // everyone else gets the same result computed live but never saved,
  // per CLAUDE.md ("AI suggestion history remains private to owners"),
  // and is rate-limited per-client since there's no auth gate to lean on.
  const access = await getOwnerAccess(supabase);
  const isOwner = !!access.user;

  if (!isOwner) {
    const rateLimit = await checkRateLimit(
      supabase,
      "PUBLIC_SUGGEST",
      clientIdentifier(request),
    );
    if (!rateLimit.admitted) {
      return NextResponse.json(
        { error: "Too many requests — try again later." },
        {
          status: 429,
          headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
        },
      );
    }
  }

  const body = (await request.json()) as RunSuggesterInput;

  if (
    typeof body.budget !== "number" ||
    !Number.isFinite(body.budget) ||
    body.budget <= 0 ||
    !body.departure_airport?.trim() ||
    body.departure_airport.trim().length > 80 ||
    !body.travel_month?.trim() ||
    body.travel_month.trim().length > 80 ||
    typeof body.nights !== "number" ||
    !Number.isInteger(body.nights) ||
    body.nights < 1 ||
    body.nights > 60
  ) {
    return NextResponse.json(
      { error: "budget, departure_airport, travel_month, and nights are all required" },
      { status: 400 },
    );
  }

  const mood = typeof body.mood === "string" ? body.mood.trim() : "";
  if (mood.length > 200) {
    return NextResponse.json(
      { error: "mood must be 200 characters or fewer" },
      { status: 400 },
    );
  }
  const hasCenter =
    body.center !== undefined &&
    Number.isFinite(body.center?.lat) &&
    Number.isFinite(body.center?.lng) &&
    body.center.lat >= -90 &&
    body.center.lat <= 90 &&
    body.center.lng >= -180 &&
    body.center.lng <= 180;
  if (body.center !== undefined && !hasCenter) {
    return NextResponse.json(
      { error: "center must be a valid { lat, lng }" },
      { status: 400 },
    );
  }
  if (
    body.radius_km !== undefined &&
    (!Number.isFinite(body.radius_km) || body.radius_km < 1 || body.radius_km > 20_000)
  ) {
    return NextResponse.json(
      { error: "radius_km must be between 1 and 20000" },
      { status: 400 },
    );
  }
  const useLocation = hasCenter && body.radius_km !== undefined;
  const maxPriceTier = maxPriceTierForBudget(body.budget, body.nights);

  // Step 1: hybrid retrieval — dense taste-vector ranking fused with a
  // keyword ranking of the mood text, after dropping wishlist pins outside
  // the radius or above the budget-derived price tier. All of that happens
  // inside rank_wishlist_hybrid (supabase/rank-wishlist-function.sql).
  const { data: ranked, error: rankError } = await supabase.rpc(
    "rank_wishlist_hybrid",
    {
      match_count: 5,
      keyword_query: mood || null,
      center_lat: useLocation ? body.center!.lat : null,
      center_lng: useLocation ? body.center!.lng : null,
      radius_km: useLocation ? body.radius_km : null,
      max_price_tier: maxPriceTier,
    },
  );

  if (rankError) {
    return NextResponse.json({ error: rankError.message }, { status: 500 });
  }

  const { data: memoryPins, error: memoryError } = await supabase
    .from("pins")
    .select("title, note, user_rating, tags")
    .eq("kind", "memory")
    .not("embedding", "is", null)
    .or("user_rating.is.null,user_rating.gte.3");

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

  const candidates: SuggesterCandidate[] = ((ranked || []) as RankedWishlistPin[]).map(
    (r) => ({
      title: r.title,
      note: r.note,
      similarity: r.similarity,
      keywordMatch: r.keyword_match,
      priceTier: r.price_tier,
      distanceKm: r.distance_km,
    }),
  );

  // Step 2: the LLM reasoning step, with the budget enforced in code —
  // an over-budget answer is retried with feedback, then rejected.
  let suggesterResult;
  let budgetAttempts = 1;
  try {
    const outcome = await runSuggesterWithinBudget({
      budget: body.budget,
      departureAirport: body.departure_airport,
      travelMonth: body.travel_month,
      nights: body.nights,
      candidates,
      memories: memoryPins,
      mood: mood || undefined,
    });
    suggesterResult = outcome.result;
    budgetAttempts = outcome.attempts;
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      // 422: the request was valid, but no answer satisfying the budget
      // constraint could be produced — not an upstream failure.
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    const message = err instanceof Error ? err.message : "Suggester failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const applied: AppliedConstraints = {
    max_price_tier: maxPriceTier,
    keyword: mood || null,
    radius_km: useLocation ? (body.radius_km ?? null) : null,
    budget_attempts: budgetAttempts,
  };

  // `ranked` (the raw rank_wishlist_hybrid output, richer than the
  // `candidates` shape passed into the prompt — it still has id/lat/lng)
  // goes back to the client as-is so the UI can actually show the
  // embeddings-driven ranking it was based on, not just the LLM's prose
  // description of it.

  // Step 3: persist, owner only. A public/demo run is never saved — built
  // as an in-memory object matching the same shape instead, so the
  // frontend renders identically either way without knowing which case
  // it's in.
  if (!isOwner) {
    const now = new Date().toISOString();
    const suggestion: Suggestion = {
      id: randomUUID(),
      status: "complete",
      budget: body.budget,
      departure_airport: body.departure_airport,
      travel_month: body.travel_month,
      nights: body.nights,
      destination: suggesterResult.destination,
      cost_breakdown: suggesterResult.costBreakdown,
      total_cost: suggesterResult.totalCost,
      created_by: "public",
      created_at: now,
      completed_at: now,
    };
    const steps: SuggestionStep[] = suggesterResult.steps.map((text, index) => ({
      id: randomUUID(),
      suggestion_id: suggestion.id,
      step_order: index + 1,
      kind: "text",
      content: { text },
      created_at: now,
    }));
    return NextResponse.json(
      { suggestion, steps, candidates: ranked, applied },
      { status: 201 },
    );
  }

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
      created_by: access.user!.id,
      completed_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (insertError) {
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

  if (stepsError) {
    // The suggestion itself saved fine; the steps are supplementary.
    // Return what we have rather than treating this as a full failure.
    console.error("Failed to persist suggestion steps:", stepsError);
    return NextResponse.json(
      { suggestion, steps: [], candidates: ranked, applied },
      { status: 201 },
    );
  }

  return NextResponse.json(
    { suggestion, steps, candidates: ranked, applied },
    { status: 201 },
  );
}
