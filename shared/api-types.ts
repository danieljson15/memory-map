// Source of truth for every API response/request shape in this app.
// Frontend and backend both import from here directly — if something
// doesn't fit a real need on either side, change this file, don't work
// around it with ad hoc types elsewhere.

export type PinKind = "memory" | "wishlist";

export interface Pin {
  id: string;
  kind: PinKind;
  lat: number;
  lng: number;
  title: string;
  note: string | null;
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
}

export interface UpdatePinInput {
  title?: string;
  note?: string;
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
  similarity: number;
}
