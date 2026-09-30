export interface Pin {
  id: string;
  kind: "memory" | "wishlist";
  lat: number;
  lng: number;
  title: string;
  note: string | null;
  place_provider: "google" | null;
  external_place_id: string | null;
  user_rating: number | null;
  tags: string[];
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
