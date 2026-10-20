import { describe, expect, it } from "vitest";
import {
  cosineSimilarity,
  distanceMeters,
  rankNearbyCandidates,
} from "@/lib/recommendations";
import { place } from "./helpers";

describe("cosineSimilarity", () => {
  it("is 1 for identical direction regardless of magnitude", () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1);
  });

  it("is 0 for orthogonal and -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it("returns 0 instead of NaN for empty, mismatched, or zero vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([1, 2], [1])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe("distanceMeters (haversine)", () => {
  it("is 0 for the same point", () => {
    expect(distanceMeters({ lat: 38.03, lng: -78.48 }, { lat: 38.03, lng: -78.48 })).toBe(0);
  });

  it("matches a known real-world distance: Paris -> London is ~344 km", () => {
    const km =
      distanceMeters({ lat: 48.8566, lng: 2.3522 }, { lat: 51.5074, lng: -0.1278 }) / 1000;
    expect(km).toBeGreaterThan(340);
    expect(km).toBeLessThan(348);
  });

  it("is symmetric", () => {
    const a = { lat: 35.68, lng: 139.69 };
    const b = { lat: -33.87, lng: 151.21 };
    expect(distanceMeters(a, b)).toBeCloseTo(distanceMeters(b, a), 6);
  });

  it("handles crossing the antimeridian (one degree of longitude at the equator ~111 km)", () => {
    const m = distanceMeters({ lat: 0, lng: 179.5 }, { lat: 0, lng: -179.5 });
    expect(m / 1000).toBeCloseTo(111.19, 0);
  });
});

describe("rankNearbyCandidates", () => {
  const center = { lat: 0, lng: 0 };
  const base = { center, radiusMeters: 1000, tasteEmbedding: [1, 0] };

  it("ranks the candidate closest to the taste vector first", () => {
    const ranked = rankNearbyCandidates({
      ...base,
      candidates: [
        place({ place_id: "off-taste", name: "Off" }),
        place({ place_id: "on-taste", name: "On" }),
      ],
      candidateEmbeddings: [[0, 1], [1, 0]],
    });
    expect(ranked.map((r) => r.place_id)).toEqual(["on-taste", "off-taste"]);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it("penalizes candidates that resemble the avoidance profile", () => {
    // Same taste similarity; only the avoidance vector differs.
    const candidates = [place({ place_id: "avoid" }), place({ place_id: "fine" })];
    const ranked = rankNearbyCandidates({
      ...base,
      tasteEmbedding: [1, 1],
      avoidanceEmbedding: [1, 0],
      candidates,
      candidateEmbeddings: [[1, 0], [0, 1]],
    });
    expect(ranked[0].place_id).toBe("fine");
  });

  it("keeps every score component bounded so score stays within [0, 1]", () => {
    const [r] = rankNearbyCandidates({
      ...base,
      candidates: [place({ rating: 5, rating_count: 10_000_000 })],
      candidateEmbeddings: [[1, 0]],
    });
    expect(r.similarity).toBeLessThanOrEqual(1);
    expect(r.score).toBeLessThanOrEqual(1);
    expect(r.score).toBeGreaterThanOrEqual(0);
  });

  it("does not let a far-away place go negative on distance", () => {
    const [r] = rankNearbyCandidates({
      ...base,
      candidates: [place({ lat: 10, lng: 10 })],
      candidateEmbeddings: [[1, 0]],
    });
    expect(r.score).toBeGreaterThan(0);
    expect(r.distance_meters).toBeGreaterThan(1_000_000);
  });

  it("treats a missing embedding as zero similarity instead of crashing", () => {
    const [r] = rankNearbyCandidates({
      ...base,
      candidates: [place()],
      candidateEmbeddings: [],
    });
    expect(r.similarity).toBeCloseTo(0.5);
  });

  it("returns at most 10 results, sorted by descending score", () => {
    const candidates = Array.from({ length: 15 }, (_, i) =>
      place({ place_id: `p${i}`, rating: 1 + (i % 5) }),
    );
    const ranked = rankNearbyCandidates({
      ...base,
      candidates,
      candidateEmbeddings: candidates.map(() => [1, 0]),
    });
    expect(ranked).toHaveLength(10);
    for (let i = 1; i < ranked.length; i += 1) {
      expect(ranked[i - 1].score).toBeGreaterThanOrEqual(ranked[i].score);
    }
  });

  it("maps Google price level to a tier and builds an explanation", () => {
    const [r] = rankNearbyCandidates({
      ...base,
      candidates: [
        place({ primary_type: "art_gallery", rating: 4.8, price_level: "PRICE_LEVEL_EXPENSIVE" }),
      ],
      candidateEmbeddings: [[1, 0]],
    });
    expect(r.price_tier).toBe(3);
    expect(r.explanation).toContain("art gallery");
    expect(r.explanation).toContain("rated 4.8");
    expect(r.explanation).toContain("from the map center");
  });

  it("does not mutate its inputs", () => {
    const candidates = [place({ place_id: "a" }), place({ place_id: "b" })];
    const snapshot = structuredClone(candidates);
    rankNearbyCandidates({ ...base, candidates, candidateEmbeddings: [[0, 1], [1, 0]] });
    expect(candidates).toEqual(snapshot);
  });
});
