// Budget handling shared by wishlist retrieval, nearby recommendations, and
// the trip suggester. Pure functions with no I/O so they are trivial to
// test and to reason about.

export type PriceTier = 1 | 2 | 3 | 4;

export const PRICE_TIER_LABELS: Record<PriceTier, string> = {
  1: "Budget-friendly",
  2: "Moderate",
  3: "Upscale",
  4: "Splurge",
};

// Converts a whole-trip budget into the most expensive price tier worth
// showing. The trip budget covers flights, lodging, food, and activities
// together, so this is a coarse heuristic on spend per night, not a
// price model — the thresholds are judgment calls, chosen so a shoestring
// budget only sees tier 1 and a generous one sees everything.
//
//   <= 100 EUR/night  -> tier 1
//   <= 200 EUR/night  -> tier 2
//   <= 350 EUR/night  -> tier 3
//   above             -> tier 4
export function maxPriceTierForBudget(budget: number, nights: number): PriceTier {
  if (!Number.isFinite(budget) || !Number.isFinite(nights) || budget <= 0 || nights <= 0) {
    return 4;
  }
  const perNight = budget / nights;
  if (perNight <= 100) return 1;
  if (perNight <= 200) return 2;
  if (perNight <= 350) return 3;
  return 4;
}

// Google's Places API (New) reports price as an enum string. Free and
// inexpensive both land in tier 1; anything unspecified is unknown (null),
// which callers treat as "do not filter out".
export function priceTierFromGoogleLevel(level: string | null | undefined): PriceTier | null {
  switch (level) {
    case "PRICE_LEVEL_FREE":
    case "PRICE_LEVEL_INEXPENSIVE":
      return 1;
    case "PRICE_LEVEL_MODERATE":
      return 2;
    case "PRICE_LEVEL_EXPENSIVE":
      return 3;
    case "PRICE_LEVEL_VERY_EXPENSIVE":
      return 4;
    default:
      return null;
  }
}

export function isPriceTier(value: unknown): value is PriceTier {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

// The budget constraint as a predicate. Unknown price (null) always passes:
// a place with no reported price is not evidence that it is expensive, and
// dropping it would silently shrink the candidate pool.
export function withinPriceTier(
  tier: number | null | undefined,
  maxTier: number | null | undefined,
): boolean {
  if (maxTier === null || maxTier === undefined) return true;
  if (tier === null || tier === undefined) return true;
  return tier <= maxTier;
}
