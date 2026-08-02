"use client";

import { useEffect, useState } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  useMapEvents,
  useMap,
} from "react-leaflet";
import L from "leaflet";
import { supabase } from "@/lib/supabaseClient";
import type { Pin } from "@/lib/types";
import PinModal from "./PinModal";

// Leaflet's default marker icons reference image files that don't resolve
// correctly under Next.js bundling, so point them at the CDN copies.
const brassIcon = new L.Icon({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  iconRetinaUrl:
    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

const EUROPE_CENTER: [number, number] = [50.5, 10.5];
const EUROPE_ZOOM = 4;

interface ClickCatcherProps {
  onMapClick: (lat: number, lng: number) => void;
}

function ClickCatcher({ onMapClick }: ClickCatcherProps) {
  useMapEvents({
    click(e) {
      onMapClick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

function MapResizeFix() {
  const map = useMap();
  useEffect(() => {
    map.invalidateSize();
  }, [map]);
  return null;
}

interface MapViewProps {
  userId: string;
}

export default function MapView({ userId }: MapViewProps) {
  const [pins, setPins] = useState<Pin[]>([]);
  const [pendingCoords, setPendingCoords] = useState<
    { lat: number; lng: number } | null
  >(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadPins() {
      const { data, error } = await supabase
        .from("pins")
        .select("*")
        .order("created_at", { ascending: false });

      if (!error && data) {
        setPins(data as Pin[]);
      }
      setLoading(false);
    }

    loadPins();
  }, []);

  async function handleDelete(pin: Pin) {
    const confirmed = window.confirm(`Delete "${pin.title}"?`);
    if (!confirmed) return;

    const { error } = await supabase.from("pins").delete().eq("id", pin.id);
    if (!error) {
      setPins((prev) => prev.filter((p) => p.id !== pin.id));
    }
  }

  return (
    <>
      {!loading && pins.length === 0 && (
        <div className="hint-banner">Click anywhere on the map to add your first memory</div>
      )}

      <MapContainer
        center={EUROPE_CENTER}
        zoom={EUROPE_ZOOM}
        style={{ height: "100%", width: "100%" }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

       <ClickCatcher onMapClick={(lat, lng) => setPendingCoords({ lat, lng })} />
<MapResizeFix />

        {pins.map((pin) => (
          <Marker
            key={pin.id}
            position={[pin.lat, pin.lng]}
            icon={brassIcon}
          >
            <Popup>
              <div className="pin-popup">
                <h3>{pin.title}</h3>
                {pin.photo_url && (
                  <img src={pin.photo_url} alt={pin.title} />
                )}
                {pin.note && <p>{pin.note}</p>}
                <button
                  className="delete-link"
                  onClick={() => handleDelete(pin)}
                >
                  Delete
                </button>
              </div>
            </Popup>
          </Marker>
        ))}
      </MapContainer>

      {pendingCoords && (
        <PinModal
          lat={pendingCoords.lat}
          lng={pendingCoords.lng}
          userId={userId}
          onClose={() => setPendingCoords(null)}
          onCreated={(newPin) => setPins((prev) => [newPin, ...prev])}
        />
      )}
    </>
  );
}
