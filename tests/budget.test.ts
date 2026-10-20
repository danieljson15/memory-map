import { describe, expect, it } from "vitest";
import {
  isPriceTier,
  maxPriceTierForBudget,
  priceTierFromGoogleLevel,
  withinPriceTier,
} from "@/lib/budget";

describe("maxPriceTierForBudget", () => {
  // Boundary values: each threshold is inclusive, so the first euro over flips the tier.
  it.each([
    [100, 1, 1],
    [101, 1, 2],
    [200, 1, 2],
    [201, 1, 3],
    [350, 1, 3],
    [351, 1, 4],
  ])("budget %i over %i night(s) -> tier %i", (budget, nights, tier) => {
    expect(maxPriceTierForBudget(budget, nights)).toBe(tier);
  });

  it("divides by nights, so the same budget over more nights is stricter", () => {
    expect(maxPriceTierForBudget(1000, 2)).toBe(4);
    expect(maxPriceTierForBudget(1000, 10)).toBe(1);
  });

  it.each([
    [0, 3],
    [-500, 3],
    [500, 0],
    [500, -1],
    [Number.NaN, 3],
    [500, Number.NaN],
    [Number.POSITIVE_INFINITY, 3],
  ])("invalid input (%s, %s) is unconstrained rather than throwing", (budget, nights) => {
    expect(maxPriceTierForBudget(budget, nights)).toBe(4);
  });
});

describe("priceTierFromGoogleLevel", () => {
  it.each([
    ["PRICE_LEVEL_FREE", 1],
    ["PRICE_LEVEL_INEXPENSIVE", 1],
    ["PRICE_LEVEL_MODERATE", 2],
    ["PRICE_LEVEL_EXPENSIVE", 3],
    ["PRICE_LEVEL_VERY_EXPENSIVE", 4],
  ])("%s -> %i", (level, tier) => {
    expect(priceTierFromGoogleLevel(level)).toBe(tier);
  });

  it.each([null, undefined, "", "PRICE_LEVEL_UNSPECIFIED", "garbage"])(
    "%s is unknown (null)",
    (level) => {
      expect(priceTierFromGoogleLevel(level)).toBeNull();
    },
  );
});

describe("isPriceTier", () => {
  it("accepts only the integers 1-4", () => {
    expect([1, 2, 3, 4].every(isPriceTier)).toBe(true);
    for (const bad of [0, 5, 2.5, "2", null, undefined, Number.NaN]) {
      expect(isPriceTier(bad)).toBe(false);
    }
  });
});

describe("withinPriceTier", () => {
  it("keeps places at or below the max tier and drops those above", () => {
    expect(withinPriceTier(2, 2)).toBe(true);
    expect(withinPriceTier(1, 2)).toBe(true);
    expect(withinPriceTier(3, 2)).toBe(false);
  });

  it("never filters out an unknown price", () => {
    expect(withinPriceTier(null, 1)).toBe(true);
    expect(withinPriceTier(undefined, 1)).toBe(true);
  });

  it("applies no filter when there is no max", () => {
    expect(withinPriceTier(4, null)).toBe(true);
    expect(withinPriceTier(4, undefined)).toBe(true);
  });
});
