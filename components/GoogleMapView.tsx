"use client";

import { useEffect, useRef, useState } from "react";
import { importLibrary, setOptions } from "@googlemaps/js-api-loader";
import { supabase } from "@/lib/supabaseClient";
import type { Pin } from "@/lib/types";
import type { PinWithPhotos, PlaceDetails } from "@/shared/api-types";
import PinModal from "./PinModal";
import SearchBox from "./SearchBox";

const EUROPE_CENTER = { lat: 50.5, lng: 10.5 };
const EUROPE_ZOOM = 4;
const MAP_THEME_KEY = "memory-map-google-theme";

type MapTheme = "light" | "dark";

let googleMapsPromise:
  | Promise<[google.maps.MapsLibrary, google.maps.MarkerLibrary]>
  | null = null;

function loadGoogleMaps() {
  const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  if (!key) {
    return Promise.reject(
      new Error(
        "NEXT_PUBLIC_GOOGLE_MAPS_API_KEY is not configured. Add a browser-restricted key with Maps JavaScript API enabled.",
      ),
    );
  }
  if (!googleMapsPromise) {
    setOptions({ key, v: "weekly", language: "en", region: "DK" });
    googleMapsPromise = Promise.all([
      importLibrary("maps"),
      importLibrary("marker"),
    ]);
  }
  return googleMapsPromise;
}

function publicPhotoUrl(pin: PinWithPhotos) {
  const path = pin.photos[0]?.storage_path;
  return path
    ? supabase.storage.from("photos").getPublicUrl(path).data.publicUrl
    : undefined;
}

export interface MapViewProps {
  userId?: string;
  refreshToken?: number;
  onCenterChange?: (center: { lat: number; lng: number }) => void;
  // Which pin, if any, to pan/zoom to and open. A controlled prop rather
  // than reading window.location.search directly, so both an initial
  // ?pin= deep link and a later selection from AllPinsModal go through
  // the same path and actually re-trigger focus on change.
  focusPinId?: string | null;
}

// The Google-backed map. Only rendered once MapView.tsx's /api/maps-config
// check admits this session under the monthly Maps JS load allowance — see
// lib/usage.ts. Never imported anywhere except MapView.tsx, so that check
// can't accidentally be bypassed by a different call site.
export default function GoogleMapView({
  userId,
  refreshToken = 0,
  onCenterChange,
  focusPinId,
}: MapViewProps) {
  const [pins, setPins] = useState<PinWithPhotos[]>([]);
  const [pendingPin, setPendingPin] = useState<{
    lat: number;
    lng: number;
    place?: PlaceDetails;
  } | null>(null);
  const [loadingPins, setLoadingPins] = useState(true);
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [photoOverrides, setPhotoOverrides] = useState<Record<string, string>>(
    {},
  );
  const [mapTheme, setMapTheme] = useState<MapTheme>(() => {
    if (typeof window === "undefined") return "light";
    return (localStorage.getItem(MAP_THEME_KEY) as MapTheme) || "light";
  });

  const mapElementRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markersRef = useRef<
    Record<string, google.maps.marker.AdvancedMarkerElement>
  >({});
  const infoWindowRef = useRef<google.maps.InfoWindow | null>(null);
  const lastViewRef = useRef({ center: EUROPE_CENTER, zoom: EUROPE_ZOOM });
  const centerCallbackRef = useRef(onCenterChange);
  const lastFocusedPinIdRef = useRef<string | null>(null);

  useEffect(() => {
    centerCallbackRef.current = onCenterChange;
  }, [onCenterChange]);

  useEffect(() => {
    localStorage.setItem(MAP_THEME_KEY, mapTheme);
  }, [mapTheme]);

  useEffect(() => {
    let cancelled = false;
    let clickListener: google.maps.MapsEventListener | undefined;
    let idleListener: google.maps.MapsEventListener | undefined;

    async function initializeMap() {
      setMapReady(false);
      setMapError(null);
      try {
        const [{ Map }, { AdvancedMarkerElement }] = await loadGoogleMaps();
        void AdvancedMarkerElement;
        if (cancelled || !mapElementRef.current) return;

        const map = new Map(mapElementRef.current, {
          center: lastViewRef.current.center,
          zoom: lastViewRef.current.zoom,
          mapId: process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID || "DEMO_MAP_ID",
          colorScheme: mapTheme === "dark" ? "DARK" : "LIGHT",
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
          clickableIcons: true,
          gestureHandling: "greedy",
        });
        mapRef.current = map;
        infoWindowRef.current = new google.maps.InfoWindow();

        clickListener = map.addListener(
          "click",
          (event: google.maps.MapMouseEvent | google.maps.IconMouseEvent) => {
            const location = event.latLng;
            if (!userId || !location) return;
            const lat = location.lat();
            const lng = location.lng();

            // Clicking a labeled POI (the little restaurant/cafe/shop icons
            // Google draws on the base map) carries a placeId — resolve it
            // through the same /api/places/details route SearchBox uses, so
            // a POI click attaches the real canonical place just like
            // searching for it and selecting it would. event.stop() blocks
            // Google's own default POI info bubble from also opening.
            if ("placeId" in event && event.placeId) {
              event.stop();
              const placeId = event.placeId;
              fetch(`/api/places/details?place_id=${encodeURIComponent(placeId)}`)
                .then((response) => response.json())
                .then((data) => {
                  if (data.place) {
                    setPendingPin({ lat, lng, place: data.place as PlaceDetails });
                  } else {
                    console.error("POI place lookup failed:", data.error);
                    setPendingPin({ lat, lng });
                  }
                })
                .catch((error) => {
                  console.error("POI place lookup failed:", error);
                  setPendingPin({ lat, lng });
                });
              return;
            }

            setPendingPin({ lat, lng });
          },
        );
        idleListener = map.addListener("idle", () => {
          const center = map.getCenter();
          if (!center) return;
          const nextCenter = { lat: center.lat(), lng: center.lng() };
          lastViewRef.current = {
            center: nextCenter,
            zoom: map.getZoom() ?? EUROPE_ZOOM,
          };
          centerCallbackRef.current?.(nextCenter);
        });
        setMapReady(true);
      } catch (error) {
        if (!cancelled) {
          setMapError(
            error instanceof Error ? error.message : "Failed to load Google Maps",
          );
        }
      }
    }

    void initializeMap();
    return () => {
      cancelled = true;
      clickListener?.remove();
      idleListener?.remove();
      infoWindowRef.current?.close();
      for (const marker of Object.values(markersRef.current)) marker.map = null;
      markersRef.current = {};
      mapRef.current = null;
    };
  }, [mapTheme, userId]);

  useEffect(() => {
    let cancelled = false;
    async function loadPins() {
      setLoadingPins(true);
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
        if (!cancelled) setLoadingPins(false);
      }
    }
    void loadPins();
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  useEffect(() => {
    const map = mapRef.current;
    const infoWindow = infoWindowRef.current;
    if (!mapReady || !map || !infoWindow) return;
    const activeMap: google.maps.Map = map;
    const activeInfoWindow: google.maps.InfoWindow = infoWindow;

    let cancelled = false;
    const listeners: google.maps.MapsEventListener[] = [];
    const createdMarkers: google.maps.marker.AdvancedMarkerElement[] = [];

    async function renderMarkers() {
      const { AdvancedMarkerElement } = await importLibrary("marker");
      if (cancelled) return;

      for (const oldMarker of Object.values(markersRef.current)) {
        oldMarker.map = null;
      }
      markersRef.current = {};

      for (const pin of pins) {
        const marker = new AdvancedMarkerElement({
          map: activeMap,
          position: { lat: pin.lat, lng: pin.lng },
          title: pin.title,
          gmpClickable: true,
        });
        const listener = marker.addListener("click", () => {
          const popup = document.createElement("div");
          popup.className = "pin-popup google-pin-popup";

          // Google's own default close button turned out unreliable to
          // color/see against this popup's fixed white background (see
          // globals.css) — built explicitly here instead, fully in our
          // control.
          const closeButton = document.createElement("button");
          closeButton.type = "button";
          closeButton.className = "pin-popup-close";
          closeButton.setAttribute("aria-label", "Close");
          closeButton.textContent = "×";
          closeButton.addEventListener("click", () => activeInfoWindow.close());
          popup.appendChild(closeButton);

          const heading = document.createElement("h3");
          heading.textContent = pin.title;
          popup.appendChild(heading);

          const photoUrl = photoOverrides[pin.id] || publicPhotoUrl(pin);
          if (photoUrl) {
            const image = document.createElement("img");
            image.src = photoUrl;
            image.alt = pin.title;
            popup.appendChild(image);
          }
          if (pin.note) {
            const note = document.createElement("p");
            note.textContent = pin.note;
            popup.appendChild(note);
          }
          if (pin.user_rating) {
            const rating = document.createElement("p");
            rating.className = "pin-popup-meta";
            rating.textContent = `Your rating: ${pin.user_rating}/5`;
            popup.appendChild(rating);
          }
          if (pin.tags.length > 0) {
            const tags = document.createElement("p");
            tags.className = "pin-popup-meta";
            tags.textContent = pin.tags.join(" · ");
            popup.appendChild(tags);
          }
          // A stable, parameter-based Google Maps link built from the
          // canonical Place ID — no Places API call needed to show it,
          // since the URL scheme doesn't require looking the place back up.
          if (pin.place_provider === "google" && pin.external_place_id) {
            const mapsLink = document.createElement("a");
            mapsLink.className = "pin-popup-maps-link";
            mapsLink.href = `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(pin.external_place_id)}`;
            mapsLink.target = "_blank";
            mapsLink.rel = "noreferrer";
            mapsLink.textContent = "View on Google Maps";
            popup.appendChild(mapsLink);
          }
          if (userId) {
            const deleteButton = document.createElement("button");
            deleteButton.className = "delete-link";
            deleteButton.textContent = "Delete";
            deleteButton.addEventListener("click", async () => {
              if (!window.confirm(`Delete "${pin.title}"?`)) return;
              const response = await fetch(`/api/pins/${pin.id}`, {
                method: "DELETE",
              });
              if (response.ok) {
                marker.map = null;
                activeInfoWindow.close();
                setPins((current) => current.filter((item) => item.id !== pin.id));
              }
            });
            popup.appendChild(deleteButton);
          }

          activeInfoWindow.setContent(popup);

          // If the marker is close enough to the top of the viewport that
          // an InfoWindow opening above it (Google's fixed default — the
          // tail graphic always points down at the anchor, so we can't
          // just flip it below without the arrow pointing the wrong way)
          // would clip under the floating topbar, pan the map down first
          // so the marker lands in clear space, then open normally. The
          // clearance value is a heuristic sized for a popup with a photo
          // and full metadata (the tallest case), not computed from this
          // specific popup's actual height — simpler than measuring a
          // DOM node that isn't rendered yet, at the cost of sometimes
          // panning a bit more than a shorter popup strictly needs.
          const TOPBAR_CLEARANCE_PX = 340;
          const markerTop = marker.element.getBoundingClientRect().top;
          const shortfall = TOPBAR_CLEARANCE_PX - markerTop;
          if (shortfall > 0) {
            activeMap.panBy(0, -shortfall);
          }

          activeInfoWindow.open({ map: activeMap, anchor: marker });
        });
        listeners.push(listener);
        createdMarkers.push(marker);
        markersRef.current[pin.id] = marker;
      }

      // Fires once per distinct focusPinId (an initial ?pin= deep link,
      // or a fresh selection from AllPinsModal) — the ref guard stops it
      // re-triggering every time this effect re-runs for an unrelated
      // reason (e.g. photoOverrides changing) while the same pin is
      // still the focus target.
      if (focusPinId && lastFocusedPinIdRef.current !== focusPinId) {
        const focusPin = pins.find((pin) => pin.id === focusPinId);
        const focusMarker = focusPin
          ? markersRef.current[focusPin.id]
          : undefined;
        if (focusPin && focusMarker) {
          lastFocusedPinIdRef.current = focusPinId;
          activeMap.panTo({ lat: focusPin.lat, lng: focusPin.lng });
          activeMap.setZoom(13);
          window.setTimeout(
            () => google.maps.event.trigger(focusMarker, "click"),
            250,
          );
        }
      }
    }

    void renderMarkers();
    return () => {
      cancelled = true;
      listeners.forEach((listener) => listener.remove());
      createdMarkers.forEach((marker) => {
        marker.map = null;
      });
    };
  }, [mapReady, photoOverrides, pins, userId, focusPinId]);

  return (
    <>
      {!loadingPins && pins.length === 0 && (
        <div className="hint-banner glass-surface">
          {userId
            ? "Search or click the map to add your first pin"
            : "Sign in to add the first pin"}
        </div>
      )}

      <SearchBox
        mapRef={mapRef}
        enabled={!!userId && mapReady}
        onSelectLocation={(place) =>
          setPendingPin({ lat: place.lat, lng: place.lng, place })
        }
      />

      <button
        type="button"
        className="theme-toggle-btn"
        onClick={() => setMapTheme((theme) => (theme === "dark" ? "light" : "dark"))}
        aria-label={mapTheme === "dark" ? "Switch to light map" : "Switch to dark map"}
        title={mapTheme === "dark" ? "Switch to light map" : "Switch to dark map"}
      >
        {mapTheme === "dark" ? "☀️" : "🌙"}
      </button>

      <div ref={mapElementRef} className="google-map" aria-label="Memory Map" />
      {mapError && <div className="map-error">{mapError}</div>}

      {pendingPin && userId && (
        <PinModal
          lat={pendingPin.lat}
          lng={pendingPin.lng}
          userId={userId}
          place={pendingPin.place}
          onClose={() => setPendingPin(null)}
          onCreated={(newPin: Pin, photoUrl) => {
            setPins((current) => [
              { ...newPin, photos: [] },
              ...current,
            ]);
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
