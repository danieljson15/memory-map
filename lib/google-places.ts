import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  PlaceDetails,
  PlacePrediction,
} from "@/shared/api-types";
import { cacheKey, getCached, setCached, CACHE_TTL_MS } from "./cache";
import { UsageLimitError } from "./usage";

// Checked only on a cache miss, right before the real Google call it
// would otherwise gate — a cache hit costs nothing, so it shouldn't
// count against (or be blocked by) the monthly usage allowance. The
// caller supplies this rather than this module importing
// admitGoogleApiUsage directly, keeping the usage-gating decision owned
// by the route/lib/usage.ts, not duplicated here.
type UsageGate = () => Promise<boolean>;

async function checkUsageGate(onCacheMiss?: UsageGate) {
  if (onCacheMiss && !(await onCacheMiss())) {
    throw new UsageLimitError();
  }
}

const PLACES_BASE_URL = "https://places.googleapis.com/v1";

interface GoogleLocalizedText {
  text?: string;
}

interface GooglePlace {
  id?: string;
  displayName?: GoogleLocalizedText;
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  primaryType?: string;
  types?: string[];
  rating?: number;
  userRatingCount?: number;
  priceLevel?: string;
}

interface GoogleAutocompleteResponse {
  suggestions?: Array<{
    placePrediction?: {
      placeId?: string;
      text?: GoogleLocalizedText;
      structuredFormat?: {
        mainText?: GoogleLocalizedText;
        secondaryText?: GoogleLocalizedText;
      };
    };
  }>;
}

function getApiKey() {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) {
    throw new Error(
      "GOOGLE_PLACES_API_KEY is not set. Add a server-side key with Places API (New) enabled.",
    );
  }
  return key;
}

async function googlePlacesFetch<T>(
  url: string,
  init: RequestInit,
  fieldMask?: string,
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  headers.set("X-Goog-Api-Key", getApiKey());
  if (fieldMask) headers.set("X-Goog-FieldMask", fieldMask);

  const response = await fetch(url, { ...init, headers, cache: "no-store" });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Google Places request failed (${response.status}): ${body}`);
  }
  return (await response.json()) as T;
}

export async function autocompletePlaces(input: {
  query: string;
  sessionToken: string;
  locationBias?: { lat: number; lng: number; radiusMeters: number };
}): Promise<PlacePrediction[]> {
  const body: Record<string, unknown> = {
    input: input.query,
    sessionToken: input.sessionToken,
    languageCode: "en",
  };

  if (input.locationBias) {
    body.locationBias = {
      circle: {
        center: {
          latitude: input.locationBias.lat,
          longitude: input.locationBias.lng,
        },
        radius: input.locationBias.radiusMeters,
      },
    };
  }

  const result = await googlePlacesFetch<GoogleAutocompleteResponse>(
    `${PLACES_BASE_URL}/places:autocomplete`,
    { method: "POST", body: JSON.stringify(body) },
  );

  return (result.suggestions ?? []).flatMap((suggestion) => {
    const prediction = suggestion.placePrediction;
    if (!prediction?.placeId || !prediction.text?.text) return [];
    return [
      {
        place_id: prediction.placeId,
        description: prediction.text.text,
        main_text:
          prediction.structuredFormat?.mainText?.text ?? prediction.text.text,
        secondary_text:
          prediction.structuredFormat?.secondaryText?.text ?? "",
      },
    ];
  });
}

function normalizePlace(place: GooglePlace): PlaceDetails {
  const lat = place.location?.latitude;
  const lng = place.location?.longitude;
  if (!place.id || !place.displayName?.text || lat === undefined || lng === undefined) {
    throw new Error("Google Places returned an incomplete place record.");
  }

  return {
    place_id: place.id,
    name: place.displayName.text,
    address: place.formattedAddress ?? "",
    lat,
    lng,
    primary_type: place.primaryType ?? null,
    types: place.types ?? [],
    // Built locally from the place_id, same stable URL scheme used for
    // saved pins — never fetched from Google. googleMapsUri used to be
    // requested here for exactly this link and nothing else; dropping it
    // from the field mask below can only reduce what's billed, never
    // increase it, regardless of which SKU tier it happened to fall
    // under.
    google_maps_uri: `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(place.id)}`,
  };
}

export async function getPlaceDetails(
  supabase: SupabaseClient,
  placeId: string,
  sessionToken?: string,
  onCacheMiss?: UsageGate,
): Promise<PlaceDetails> {
  // sessionToken is deliberately excluded from the cache key — it only
  // affects Google's autocomplete+details billing bundling, not the
  // actual place data, so two different sessions looking up the same
  // placeId should still be the same cache entry.
  const key = cacheKey("place_details", { placeId, languageCode: "en" });
  const cached = await getCached<PlaceDetails>(supabase, key);
  if (cached) return cached;

  await checkUsageGate(onCacheMiss);

  const query = new URLSearchParams({ languageCode: "en" });
  if (sessionToken) query.set("sessionToken", sessionToken);

  const place = await googlePlacesFetch<GooglePlace>(
    `${PLACES_BASE_URL}/places/${encodeURIComponent(placeId)}?${query}`,
    { method: "GET" },
    "id,displayName,formattedAddress,location,primaryType,types",
  );
  const details = normalizePlace(place);
  await setCached(supabase, key, details, CACHE_TTL_MS.PLACE_DETAILS);
  return details;
}

export interface GoogleNearbyPlace extends PlaceDetails {
  rating: number | null;
  rating_count: number;
  price_level: string | null;
}

const NEARBY_TYPE_GROUPS = [
  ["restaurant", "cafe", "bakery", "bar"],
  ["museum", "art_gallery", "tourist_attraction", "performing_arts_theater"],
  ["park", "book_store", "clothing_store", "shopping_mall"],
] as const;

export async function searchNearbyPlaces(
  supabase: SupabaseClient,
  input: {
    lat: number;
    lng: number;
    radiusMeters: number;
  },
  onCacheMiss?: UsageGate,
): Promise<GoogleNearbyPlace[]> {
  // Rounded to ~11m precision so two requests centered on "the same"
  // spot (e.g. the map settling a few pixels apart) still hit the same
  // cache entry instead of missing on floating-point noise.
  const key = cacheKey("nearby_search", {
    lat: Math.round(input.lat * 10_000) / 10_000,
    lng: Math.round(input.lng * 10_000) / 10_000,
    radiusMeters: input.radiusMeters,
  });
  const cached = await getCached<GoogleNearbyPlace[]>(supabase, key);
  if (cached) return cached;

  await checkUsageGate(onCacheMiss);

  const fieldMask = [
    "places.id",
    "places.displayName",
    "places.formattedAddress",
    "places.location",
    "places.primaryType",
    "places.types",
    "places.rating",
    "places.userRatingCount",
    "places.priceLevel",
  ].join(",");

  const results = await Promise.all(
    NEARBY_TYPE_GROUPS.map(async (includedTypes) => {
      const response = await googlePlacesFetch<{ places?: GooglePlace[] }>(
        `${PLACES_BASE_URL}/places:searchNearby`,
        {
          method: "POST",
          body: JSON.stringify({
            includedTypes,
            maxResultCount: 20,
            rankPreference: "POPULARITY",
            languageCode: "en",
            locationRestriction: {
              circle: {
                center: { latitude: input.lat, longitude: input.lng },
                radius: input.radiusMeters,
              },
            },
          }),
        },
        fieldMask,
      );
      return response.places ?? [];
    }),
  );

  const unique = new Map<string, GoogleNearbyPlace>();
  for (const place of results.flat()) {
    const normalized = normalizePlace(place);
    unique.set(normalized.place_id, {
      ...normalized,
      rating: place.rating ?? null,
      rating_count: place.userRatingCount ?? 0,
      price_level: place.priceLevel ?? null,
    });
  }
  const places = [...unique.values()];
  await setCached(supabase, key, places, CACHE_TTL_MS.NEARBY_SEARCH);
  return places;
}
