"use client";

import { useEffect, useRef, useState } from "react";
import type { PlaceDetails, PlacePrediction } from "@/shared/api-types";

interface SearchBoxProps {
  mapRef: React.RefObject<google.maps.Map | null>;
  enabled: boolean;
  onSelectLocation: (place: PlaceDetails) => void;
}

function newSessionToken() {
  return crypto.randomUUID();
}

export default function SearchBox({
  mapRef,
  enabled,
  onSelectLocation,
}: SearchBoxProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PlacePrediction[]>([]);
  const [open, setOpen] = useState(false);
  const [loadingPlaceId, setLoadingPlaceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const skipNextSearchRef = useRef(false);
  const sessionTokenRef = useRef("");

  useEffect(() => {
    if (!enabled) {
      setResults([]);
      setOpen(false);
      return;
    }
    if (skipNextSearchRef.current) {
      skipNextSearchRef.current = false;
      return;
    }
    if (query.trim().length < 3) {
      setResults([]);
      setError(null);
      if (query.trim().length === 0) sessionTokenRef.current = "";
      return;
    }

    const timeout = setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      if (!sessionTokenRef.current) sessionTokenRef.current = newSessionToken();

      const center = mapRef.current?.getCenter();
      try {
        const response = await fetch("/api/places/autocomplete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            input: query.trim(),
            session_token: sessionTokenRef.current,
            location_bias: center
              ? { lat: center.lat(), lng: center.lng(), radius_meters: 50_000 }
              : undefined,
          }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Place search failed");
        setResults(data.predictions as PlacePrediction[]);
        setError(null);
        setOpen(true);
      } catch (searchError) {
        if ((searchError as Error).name !== "AbortError") {
          setResults([]);
          setOpen(true);
          setError(
            searchError instanceof Error ? searchError.message : "Place search failed",
          );
        }
      }
    }, 350);

    return () => clearTimeout(timeout);
  }, [enabled, mapRef, query]);

  async function handleSelect(result: PlacePrediction) {
    if (loadingPlaceId) return;
    setLoadingPlaceId(result.place_id);
    setError(null);
    try {
      const params = new URLSearchParams({
        place_id: result.place_id,
        session_token: sessionTokenRef.current,
      });
      const response = await fetch(`/api/places/details?${params}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Place lookup failed");
      const place = data.place as PlaceDetails;

      mapRef.current?.panTo({ lat: place.lat, lng: place.lng });
      mapRef.current?.setZoom(15);
      onSelectLocation(place);

      skipNextSearchRef.current = true;
      setQuery(place.name);
      setResults([]);
      setOpen(false);
      sessionTokenRef.current = "";
    } catch (selectionError) {
      setError(
        selectionError instanceof Error
          ? selectionError.message
          : "Place lookup failed",
      );
      setOpen(true);
    } finally {
      setLoadingPlaceId(null);
    }
  }

  return (
    <div className="search-box">
      <input
        type="text"
        className="search-input"
        placeholder={enabled ? "Search for a real place" : "Sign in to search places"}
        aria-label="Search for a place"
        disabled={!enabled}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onFocus={() => (results.length > 0 || error) && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && results[0]) {
            event.preventDefault();
            void handleSelect(results[0]);
          } else if (event.key === "Escape") {
            setOpen(false);
          }
        }}
      />

      {open && (
        <div className="search-results-panel">
          {error && <p className="search-error">{error}</p>}
          {!error && results.length === 0 && (
            <p className="search-empty">No matching places</p>
          )}
          {results.length > 0 && (
            <ul className="search-results">
              {results.map((result) => (
                <li key={result.place_id}>
                  <button
                    type="button"
                    disabled={loadingPlaceId !== null}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      void handleSelect(result);
                    }}
                  >
                    <span className="place-result-main">{result.main_text}</span>
                    {result.secondary_text && (
                      <span className="place-result-secondary">
                        {result.secondary_text}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="google-attribution">Google Maps</p>
        </div>
      )}
    </div>
  );
}
