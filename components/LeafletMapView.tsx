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
import type { Pin } from "@/lib/types";
import type { PinWithPhotos } from "@/shared/api-types";
import type { MapViewProps } from "./GoogleMapView";
import PinModal from "./PinModal";

// Leaflet's default marker icons reference image files that don't resolve
// correctly under Next.js bundling, so point them at the CDN copies —
// same workaround this app used before the Google Maps refactor.
const pinIcon = new L.Icon({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  iconRetinaUrl:
    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
});

const EUROPE_CENTER: [number, number] = [50.5, 10.5];
const EUROPE_ZOOM = 4;
const TILE_THEME_KEY = "memory-map-tile-theme";

// CARTO's basemaps prefer the `name:en` OSM tag when available, unlike raw
// OSM standard tiles which always render the local-language name — see
// the note this app already carried before the Google refactor.
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

function publicPhotoUrl(pin: PinWithPhotos) {
  const path = pin.photos[0]?.storage_path;
  return path
    ? supabase.storage.from("photos").getPublicUrl(path).data.publicUrl
    : undefined;
}

interface ClickCatcherProps {
  onMapClick: (lat: number, lng: number) => void;
}

function ClickCatcher({ onMapClick }: ClickCatcherProps) {
  useMapEvents({
    click(event) {
      onMapClick(event.latlng.lat, event.latlng.lng);
    },
  });
  return null;
}

function CenterReporter({
  onCenterChange,
}: {
  onCenterChange?: (center: { lat: number; lng: number }) => void;
}) {
  useMapEvents({
    moveend(event) {
      const center = event.target.getCenter();
      onCenterChange?.({ lat: center.lat, lng: center.lng });
    },
  });
  return null;
}

// Fixes a well-known react-leaflet issue where the map's internal size
// cache goes stale if the container wasn't its final size when the map
// was created (e.g. behind a flex layout that resolves after mount).
function MapResizeFix() {
  const map = useMap();
  useEffect(() => {
    const timeout = setTimeout(() => map.invalidateSize(), 0);
    return () => clearTimeout(timeout);
  }, [map]);
  return null;
}

// The OpenStreetMap/Leaflet fallback map. Rendered by MapView.tsx when
// /api/maps-config reports this month's Google Maps JS load allowance is
// spent — see lib/usage.ts. Deliberately narrower than GoogleMapView:
// no place search (Places usage is tracked and capped independently, but
// SearchBox is built directly against the google.maps.Map API to pan/zoom
// the map on a selected result, so it has no meaning here without a
// larger provider-agnostic rework). Manual pin creation by clicking the
// map still works, since that never touched Google to begin with.
export default function LeafletMapView({
  userId,
  refreshToken = 0,
  onCenterChange,
  focusPinId,
}: MapViewProps) {
  const [pins, setPins] = useState<PinWithPhotos[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingCoords, setPendingCoords] = useState<
    { lat: number; lng: number } | null
  >(null);
  const [photoOverrides, setPhotoOverrides] = useState<Record<string, string>>(
    {},
  );
  const [tileTheme, setTileTheme] = useState<TileTheme>(() => {
    if (typeof window === "undefined") return "light";
    return (localStorage.getItem(TILE_THEME_KEY) as TileTheme) || "light";
  });
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<Record<string, L.Marker>>({});
  const lastFocusedPinIdRef = useRef<string | null>(null);

  // Same focusPinId contract as GoogleMapView — an initial ?pin= deep
  // link or a fresh selection from AllPinsModal. Leaflet markers are
  // real L.Marker instances (via each Marker's ref callback below), so
  // opening one's popup is direct — no marker-click-simulation needed.
  useEffect(() => {
    if (!focusPinId || lastFocusedPinIdRef.current === focusPinId) return;
    const focusPin = pins.find((pin) => pin.id === focusPinId);
    const focusMarker = focusPin ? markersRef.current[focusPin.id] : undefined;
    if (focusPin && focusMarker && mapRef.current) {
      lastFocusedPinIdRef.current = focusPinId;
      mapRef.current.setView([focusPin.lat, focusPin.lng], 13);
      window.setTimeout(() => focusMarker.openPopup(), 250);
    }
  }, [focusPinId, pins]);

  useEffect(() => {
    localStorage.setItem(TILE_THEME_KEY, tileTheme);
  }, [tileTheme]);

  useEffect(() => {
    let cancelled = false;
    async function loadPins() {
      setLoading(true);
      try {
        const response = await fetch("/api/pins", { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Failed to load pins");
        if (!cancelled) setPins(data.pins as PinWithPhotos[]);
      } catch (error) {
        if (!cancelled) {
          console.error("Failed to load map pins:", error);
          setPins([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void loadPins();
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  return (
    <>
      <div className="hint-banner glass-surface map-fallback-banner">
        Google Maps usage limit reached this month — showing a simplified
        map. Saved pins and manual pin creation still work.
      </div>

      {!loading && pins.length === 0 && (
        <div className="hint-banner glass-surface map-fallback-empty-banner">
          {userId
            ? "Click the map to add your first pin"
            : "Sign in to add the first pin"}
        </div>
      )}

      <button
        type="button"
        className="theme-toggle-btn"
        onClick={() => setTileTheme((theme) => (theme === "dark" ? "light" : "dark"))}
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
        <CenterReporter onCenterChange={onCenterChange} />
        <MapResizeFix />

        {pins.map((pin) => (
          <Marker
            key={pin.id}
            position={[pin.lat, pin.lng]}
            icon={pinIcon}
            ref={(instance) => {
              if (instance) markersRef.current[pin.id] = instance;
              else delete markersRef.current[pin.id];
            }}
          >
            <Popup>
              <div className="pin-popup">
                <h3>{pin.title}</h3>
                {(photoOverrides[pin.id] || publicPhotoUrl(pin)) && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={photoOverrides[pin.id] || publicPhotoUrl(pin)}
                    alt={pin.title}
                  />
                )}
                {pin.note && <p>{pin.note}</p>}
                {pin.user_rating && (
                  <p className="pin-popup-meta">
                    Your rating: {pin.user_rating}/5
                  </p>
                )}
                {pin.tags.length > 0 && (
                  <p className="pin-popup-meta">{pin.tags.join(" · ")}</p>
                )}
                {pin.place_provider === "google" && pin.external_place_id && (
                  <a
                    className="pin-popup-maps-link"
                    href={`https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(pin.external_place_id)}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View on Google Maps
                  </a>
                )}
                {userId && (
                  <button
                    type="button"
                    className="delete-link"
                    onClick={async () => {
                      if (!window.confirm(`Delete "${pin.title}"?`)) return;
                      const response = await fetch(`/api/pins/${pin.id}`, {
                        method: "DELETE",
                      });
                      if (response.ok) {
                        setPins((current) =>
                          current.filter((item) => item.id !== pin.id),
                        );
                      }
                    }}
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
          onClose={() => setPendingCoords(null)}
          onCreated={(newPin: Pin, photoUrl) => {
            setPins((current) => [{ ...newPin, photos: [] }, ...current]);
            if (photoUrl) {
              setPhotoOverrides((current) => ({
                ...current,
                [newPin.id]: photoUrl,
              }));
            }
          }}
        />
      )}
    </>
  );
}
