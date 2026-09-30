// Source of truth for every API response/request shape in this app.
// Frontend and backend both import from here directly — if something
// doesn't fit a real need on either side, change this file, don't work
// around it with ad hoc types elsewhere.

export type PinKind = "memory" | "wishlist";

export type PlaceProvider = "google";

export interface Pin {
  id: string;
  kind: PinKind;
  lat: number;
  lng: number;
  title: string;
  note: string | null;
  place_provider: PlaceProvider | null;
  external_place_id: string | null;
  user_rating: number | null;
  tags: string[];
  // 1 (budget-friendly) .. 4 (splurge); null means unknown and is never
  // filtered out by a budget constraint. See lib/budget.ts.
  price_tier: number | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface PinPhoto {
  id: string;
  pin_id: string;
  storage_path: string;
  created_by: string;
  created_at: string;
}

export interface PinWithPhotos extends Pin {
  photos: PinPhoto[];
}

export interface CreatePinInput {
  kind: PinKind;
  lat: number;
  lng: number;
  title: string;
  note?: string;
  place_provider?: PlaceProvider;
  external_place_id?: string;
  user_rating?: number;
  tags?: string[];
  price_tier?: number;
}

export interface UpdatePinInput {
  kind?: PinKind;
  title?: string;
  note?: string;
  user_rating?: number | null;
  tags?: string[];
  price_tier?: number | null;
}

export interface RegisterPhotoInput {
  storage_path: string;
}

export interface Trip {
  id: string;
  title: string;
  start_date: string | null;
  end_date: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CreateTripInput {
  title: string;
  start_date?: string;
  end_date?: string;
}

export interface UpdateTripInput {
  title?: string;
  start_date?: string;
  end_date?: string;
}

export interface ChecklistItem {
  id: string;
  trip_id: string;
  text: string;
  is_done: boolean;
  created_by: string;
  created_at: string;
}

export interface CreateChecklistItemInput {
  text: string;
}

export interface UpdateChecklistItemInput {
  text?: string;
  is_done?: boolean;
}

export type SuggestionStatus = "running" | "complete" | "failed";

export interface CostBreakdown {
  flights: number;
  lodging: number;
  food: number;
  activities: number;
}

export interface Suggestion {
  id: string;
  status: SuggestionStatus;
  budget: number | null;
  departure_airport: string | null;
  travel_month: string | null;
  nights: number | null;
  destination: string | null;
  cost_breakdown: CostBreakdown | null;
  total_cost: number | null;
  created_by: string;
  created_at: string;
  completed_at: string | null;
}

export type SuggestionStepKind = "text" | "tool_call";

export interface SuggestionStep {
  id: string;
  suggestion_id: string;
  step_order: number;
  kind: SuggestionStepKind;
  content: { text: string } | { tool: string; input: unknown; result: unknown };
  created_at: string;
}

export interface RunSuggesterInput {
  budget: number;
  departure_airport: string;
  travel_month: string;
  nights: number;
  // Optional free text ("quiet coastal seafood") for the keyword leg of
  // hybrid retrieval. Empty or absent means dense-only ranking.
  mood?: string;
  // Optional location constraint: only wishlist pins within radius_km of
  // this point are considered.
  center?: { lat: number; lng: number };
  radius_km?: number;
}

// Echoed back by /api/suggest so the UI can show which constraints actually
// shaped the candidate list, instead of leaving it implied.
export interface AppliedConstraints {
  max_price_tier: number;
  keyword: string | null;
  radius_km: number | null;
  budget_attempts: number;
}

// Timeline: memory-feed pagination
export interface TimelinePage {
  pins: PinWithPhotos[];
  next_cursor: string | null;
}

export interface RankedWishlistPin {
  id: string;
  title: string;
  note: string | null;
  lat: number;
  lng: number;
  price_tier: number | null;
  // Cosine similarity to the taste vector (dense leg).
  similarity: number;
  // 1-based positions within each leg; sparse_position is null when the
  // pin did not match the keyword query (or none was given).
  dense_position: number;
  sparse_position: number | null;
  keyword_match: boolean;
  // Present only when a location constraint was applied.
  distance_km: number | null;
  // Reciprocal rank fusion score the final order is sorted by.
  rrf_score: number;
}

export interface PlaceAutocompleteInput {
  input: string;
  session_token: string;
  location_bias?: { lat: number; lng: number; radius_meters?: number };
}

export interface PlacePrediction {
  place_id: string;
  description: string;
  main_text: string;
  secondary_text: string;
}

export interface PlaceDetails {
  place_id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  primary_type: string | null;
  types: string[];
  google_maps_uri: string | null;
}

export interface NearbyRecommendationsInput {
  lat: number;
  lng: number;
  radius_meters?: number;
  // Drop candidates priced above this tier (1-4). Candidates with no
  // reported price are kept, since unknown is not the same as expensive.
  max_price_tier?: number;
}

export interface NearbyRecommendation extends PlaceDetails {
  rating: number | null;
  rating_count: number;
  price_level: string | null;
  price_tier: number | null;
  distance_meters: number;
  similarity: number;
  score: number;
  explanation: string;
}

// Which map provider the frontend should render this session. "leaflet"
// means the self-imposed monthly Google Maps JS load allowance is spent
// for this period — see lib/usage.ts and public.google_api_usage.
export type MapProvider = "google" | "leaflet";

export interface MapsConfigResponse {
  provider: MapProvider;
}
