import type { GoogleNearbyPlace } from "@/lib/google-places";
import type { NearbyRecommendation } from "@/shared/api-types";
import { priceTierFromGoogleLevel } from "@/lib/budget";

export function cosineSimilarity(a: number[], b: number[]) {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    magnitudeA += a[i] * a[i];
    magnitudeB += b[i] * b[i];
  }
  if (magnitudeA === 0 || magnitudeB === 0) return 0;
  return dot / (Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB));
}

export function distanceMeters(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
) {
  const earthRadiusMeters = 6_371_000;
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDelta = toRadians(to.lat - from.lat);
  const longitudeDelta = toRadians(to.lng - from.lng);
  const fromLatitude = toRadians(from.lat);
  const toLatitude = toRadians(to.lat);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(fromLatitude) *
      Math.cos(toLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 2 * earthRadiusMeters * Math.asin(Math.sqrt(haversine));
}

export function rankNearbyCandidates(input: {
  candidates: GoogleNearbyPlace[];
  candidateEmbeddings: number[][];
  tasteEmbedding: number[];
  avoidanceEmbedding?: number[];
  center: { lat: number; lng: number };
  radiusMeters: number;
}): NearbyRecommendation[] {
  return input.candidates
    .map((candidate, index) => {
      const rawSimilarity = cosineSimilarity(
        input.tasteEmbedding,
        input.candidateEmbeddings[index] ?? [],
      );
      const avoidanceSimilarity = input.avoidanceEmbedding
        ? Math.max(
            0,
            cosineSimilarity(
              input.avoidanceEmbedding,
              input.candidateEmbeddings[index] ?? [],
            ),
          )
        : 0;
      const adjustedSimilarity = rawSimilarity - avoidanceSimilarity * 0.25;
      const similarity = Math.max(
        0,
        Math.min(1, (adjustedSimilarity + 1) / 2),
      );
      const ratingScore = candidate.rating ? candidate.rating / 5 : 0.6;
      const popularityScore = Math.min(
        1,
        Math.log10(candidate.rating_count + 1) / 4,
      );
      const distance = distanceMeters(input.center, candidate);
      const distanceScore = Math.max(0, 1 - distance / input.radiusMeters);
      const score =
        similarity * 0.65 +
        ratingScore * 0.15 +
        popularityScore * 0.1 +
        distanceScore * 0.1;

      const typeLabel = (candidate.primary_type ?? "place").replaceAll("_", " ");
      const reasons = [`Matches your saved-place taste as a ${typeLabel}`];
      if (candidate.rating && candidate.rating >= 4.4) {
        reasons.push(`rated ${candidate.rating.toFixed(1)} by visitors`);
      }
      if (distance < 1500) {
        reasons.push(`${Math.max(1, Math.round(distance))} m from the map center`);
      }

      return {
        ...candidate,
        price_tier: priceTierFromGoogleLevel(candidate.price_level),
        distance_meters: Math.round(distance),
        similarity,
        score,
        explanation: reasons.join(", "),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}
