export interface Pin {
  id: string;
  lat: number;
  lng: number;
  title: string;
  note: string | null;
  photo_url: string | null;
  created_by: string;
  created_at: string;
}
