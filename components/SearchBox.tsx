"use client";

import { useEffect, useRef, useState } from "react";
import type { Map as LeafletMap } from "leaflet";

interface NominatimResult {
  place_id: number;
  display_name: string;
  boundingbox: [string, string, string, string];
}

interface SearchBoxProps {
  mapRef: React.RefObject<LeafletMap | null>;
}

export default function SearchBox({ mapRef }: SearchBoxProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<NominatimResult[]>([]);
  const [open, setOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const skipNextSearchRef = useRef(false);

  useEffect(() => {
    if (skipNextSearchRef.current) {
      skipNextSearchRef.current = false;
      return;
    }

    if (query.trim().length < 3) {
      setResults([]);
      return;
    }

    const timeout = setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const url = `https://nominatim.openstreetmap.org/search?format=json&accept-language=en&limit=5&q=${encodeURIComponent(query)}`;
        const res = await fetch(url, { signal: controller.signal });
        const data: NominatimResult[] = await res.json();
        setResults(data);
        setOpen(true);
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setResults([]);
        }
      }
    }, 400);

    return () => clearTimeout(timeout);
  }, [query]);

  function handleSelect(result: NominatimResult) {
    const map = mapRef.current;
    if (!map) return;

    const [south, north, west, east] = result.boundingbox.map(Number);
    map.fitBounds(
      [
        [south, west],
        [north, east],
      ],
      { padding: [40, 40], maxZoom: 15 },
    );

    skipNextSearchRef.current = true;
    setQuery(result.display_name);
    setResults([]);
    setOpen(false);
  }

  return (
    <div className="search-box">
      <input
        type="text"
        className="search-input"
        placeholder="Search for a place"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 100)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && results[0]) {
            handleSelect(results[0]);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {open && results.length > 0 && (
        <ul className="search-results">
          {results.map((result) => (
            <li key={result.place_id}>
              <button type="button" onMouseDown={() => handleSelect(result)}>
                {result.display_name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
