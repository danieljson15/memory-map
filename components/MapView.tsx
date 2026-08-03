"use client";

import { useEffect, useRef, useState } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  ZoomControl,
  useMapEvents,
  useMap,
} from "react-leaflet";
import L from "leaflet";
import { supabase } from "@/lib/supabaseClient";
import type { Pin, PinPhoto } from "@/lib/types";
import PinModal from "./PinModal";
import SearchBox from "./SearchBox";

// Leaflet's default marker icons reference image files that don't resolve
// correctly under Next.js bundling, so point them at the CDN copies.
const pinIcon = new L.Icon({
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

const TILE_THEME_KEY = "memory-map-tile-theme";

// Both light and dark use CARTO's basemaps (not raw OSM standard tiles for
// light) because CARTO's style prefers the `name:en` tag when available,
// falling back to the local name only if no English translation exists in
// the OSM data. Raw OSM standard tiles always render the local-language
// name regardless — that mismatch is why light mode used to show
// "Україна" while dark mode showed "Ukraine" for the same country.
const TILE_LAYERS = {
  light: {
    url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  },
  dark: {
    url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  },
} as const;

type TileTheme = keyof typeof TILE_LAYERS;

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
  userId?: string;
}

export default function MapView({ userId }: MapViewProps) {
  const [pins, setPins] = useState<Pin[]>([]);
  const [pendingCoords, setPendingCoords] = useState<
    { lat: number; lng: number; suggestedTitle?: string } | null
  >(null);
  const [loading, setLoading] = useState(true);
  const [photosByPin, setPhotosByPin] = useState<Record<string, string>>({});
  const [tileTheme, setTileTheme] = useState<TileTheme>(() => {
    if (typeof window === "undefined") return "light";
    return (localStorage.getItem(TILE_THEME_KEY) as TileTheme) || "light";
  });
  const mapRef = useRef<L.Map | null>(null);
  const markerRefs = useRef<Record<string, L.Marker | null>>({});
  // Guards the "?pin=<id> -> fly to it and open its popup" behavior (used
  // when arriving from /pins) so it only runs once per mount, not every
  // time `pins` changes for an unrelated reason (e.g. a new pin created).
  const focusedFromUrlRef = useRef(false);

  useEffect(() => {
    localStorage.setItem(TILE_THEME_KEY, tileTheme);
  }, [tileTheme]);

  useEffect(() => {
    async function loadPhotos(loadedPins: Pin[]) {
      if (loadedPins.length === 0) return;

      const { data: photos, error: photosError } = await supabase
        .from("pin_photos")
        .select("*")
        .in(
          "pin_id",
          loadedPins.map((p) => p.id),
        )
        .order("created_at", { ascending: true });

      if (photosError || !photos) return;

      // First photo per pin — table is one-to-many, but only one is shown.
      const firstPathByPin: Record<string, string> = {};
      for (const photo of photos as PinPhoto[]) {
        if (!firstPathByPin[photo.pin_id]) {
          firstPathByPin[photo.pin_id] = photo.storage_path;
        }
      }

      const paths = Object.values(firstPathByPin);
      if (paths.length === 0) return;

      const { data: signedUrls, error: signError } = await supabase.storage
        .from("photos")
        .createSignedUrls(paths, 3600);

      if (signError || !signedUrls) return;

      const urlByPath: Record<string, string> = {};
      for (const item of signedUrls) {
        if (item.path && item.signedUrl) urlByPath[item.path] = item.signedUrl;
      }

      const urlByPin: Record<string, string> = {};
      for (const [pinId, path] of Object.entries(firstPathByPin)) {
        const url = urlByPath[path];
        if (url) urlByPin[pinId] = url;
      }

      setPhotosByPin(urlByPin);
    }

    async function loadPins() {
      const { data, error } = await supabase
        .from("pins")
        .select("*")
        .order("created_at", { ascending: false });

      if (!error && data) {
        setPins(data as Pin[]);
        await loadPhotos(data as Pin[]);
      }
      setLoading(false);
    }

    loadPins();
  }, []);

  // Arriving from /pins with ?pin=<id> — fly to that pin and open its
  // popup once it's actually on the map. Runs once per mount; a pin
  // created afterward (which also updates `pins`) shouldn't re-trigger it.
  useEffect(() => {
    if (focusedFromUrlRef.current) return;
    if (pins.length === 0) return;

    const params = new URLSearchParams(window.location.search);
    const focusPinId = params.get("pin");
    if (!focusPinId) return;

    const pin = pins.find((p) => p.id === focusPinId);
    if (!pin) return;

    focusedFromUrlRef.current = true;

    const map = mapRef.current;
    const marker = markerRefs.current[pin.id];
    // Opening the popup immediately (before flyTo's animation settles) gets
    // it closed within a few hundred ms — Leaflet's own zoom/pan handling
    // resets the popup layer mid-flight. Waiting for `moveend` avoids the
    // race; flyTo covering a long distance (e.g. the default Europe view to
    // a single city) can take several seconds, so the popup opens once the
    // flight actually finishes rather than immediately on click.
    map?.once("moveend", () => marker?.openPopup());
    map?.flyTo([pin.lat, pin.lng], 13);
  }, [pins]);

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
        <div className="hint-banner glass-surface">Click anywhere on the map to add your first memory</div>
      )}

      <SearchBox
        mapRef={mapRef}
        onSelectLocation={
          userId
            ? (lat, lng, suggestedTitle) =>
                setPendingCoords({ lat, lng, suggestedTitle })
            : undefined
        }
      />

      <button
        type="button"
        className="theme-toggle-btn"
        onClick={() => setTileTheme((t) => (t === "dark" ? "light" : "dark"))}
        aria-label={tileTheme === "dark" ? "Switch to light map" : "Switch to dark map"}
        title={tileTheme === "dark" ? "Switch to light map" : "Switch to dark map"}
      >
        {tileTheme === "dark" ? "☀️" : "🌙"}
      </button>

      <MapContainer
        ref={mapRef}
        center={EUROPE_CENTER}
        zoom={EUROPE_ZOOM}
        zoomControl={false}
        style={{ height: "100%", width: "100%" }}
      >
        <TileLayer
          key={tileTheme}
          attribution={TILE_LAYERS[tileTheme].attribution}
          url={TILE_LAYERS[tileTheme].url}
        />
        <ZoomControl position="bottomleft" />

       <ClickCatcher
          onMapClick={(lat, lng) => {
            if (!userId) return;
            setPendingCoords({ lat, lng });
          }}
        />
<MapResizeFix />

        {pins.map((pin) => (
          <Marker
            key={pin.id}
            position={[pin.lat, pin.lng]}
            icon={pinIcon}
            ref={(marker) => {
              markerRefs.current[pin.id] = marker;
            }}
          >
            <Popup minWidth={350} maxWidth={460}>
              <div className="pin-popup">
                <h3>{pin.title}</h3>
                {photosByPin[pin.id] && (
                  <img src={photosByPin[pin.id]} alt={pin.title} />
                )}
                {pin.note && <p>{pin.note}</p>}
                {userId && (
                  <button
                    className="delete-link"
                    onClick={() => handleDelete(pin)}
                  >
                    Delete
                  </button>
                )}
              </div>
            </Popup>
          </Marker>
        ))}
      </MapContainer>

      {pendingCoords && userId && (
        <PinModal
          lat={pendingCoords.lat}
          lng={pendingCoords.lng}
          userId={userId}
          initialTitle={pendingCoords.suggestedTitle}
          onClose={() => setPendingCoords(null)}
          onCreated={(newPin, photoUrl) => {
            setPins((prev) => [newPin, ...prev]);
            if (photoUrl) {
              setPhotosByPin((prev) => ({ ...prev, [newPin.id]: photoUrl }));
            }
          }}
        />
      )}
    </>
  );
}
