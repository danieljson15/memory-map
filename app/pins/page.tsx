"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import type { PinKind, PinWithPhotos } from "@/shared/api-types";

type KindFilter = "all" | PinKind;

const KIND_LABELS: Record<PinKind, string> = {
  memory: "Memory",
  wishlist: "Wishlist",
};

const KIND_TABS: { value: KindFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "memory", label: "Memories" },
  { value: "wishlist", label: "Wishlist" },
];

// The `photos` bucket is public (see supabase/schema.sql), so a plain
// public URL resolves directly — no signed-URL round trip needed here.
function resolvePhotoUrl(pin: PinWithPhotos): string | null {
  const path = pin.photos[0]?.storage_path;
  if (!path) return null;
  return supabase.storage.from("photos").getPublicUrl(path).data.publicUrl;
}

export default function PinsPage() {
  const router = useRouter();
  const [pins, setPins] = useState<PinWithPhotos[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [query, setQuery] = useState("");

  useEffect(() => {
    async function loadPins() {
      try {
        const res = await fetch("/api/pins");
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to load pins");
        setPins(data.pins as PinWithPhotos[]);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load pins");
      } finally {
        setLoading(false);
      }
    }

    loadPins();
  }, []);

  const filteredPins = useMemo(() => {
    const q = query.trim().toLowerCase();
    return pins.filter((pin) => {
      if (kindFilter !== "all" && pin.kind !== kindFilter) return false;
      if (!q) return true;
      return (
        pin.title.toLowerCase().includes(q) ||
        (pin.note ?? "").toLowerCase().includes(q)
      );
    });
  }, [pins, kindFilter, query]);

  function handleSelect(pin: PinWithPhotos) {
    router.push(`/?pin=${pin.id}`);
  }

  const emptyMessage =
    pins.length === 0
      ? "No pins yet"
      : kindFilter === "memory"
        ? "No memories yet"
        : kindFilter === "wishlist"
          ? "No wishlist pins yet"
          : "No pins match your search";

  return (
    <div className="pins-page">
      <div className="pins-header">
        <Link href="/" className="back-link">
          ← Back to map
        </Link>
        <h1>All pins</h1>
      </div>

      <div className="pins-filters">
        <div className="pins-kind-filter">
          {KIND_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              className={`pins-kind-btn${kindFilter === tab.value ? " active" : ""}`}
              onClick={() => setKindFilter(tab.value)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <input
          type="text"
          className="pins-search-input"
          placeholder="Filter by title or note"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {loading && <p className="pins-status">Loading pins…</p>}
      {error && <p className="pins-status error-text">{error}</p>}

      {!loading && !error && filteredPins.length === 0 && (
        <p className="pins-empty">{emptyMessage}</p>
      )}

      {!loading && !error && filteredPins.length > 0 && (
        <div className="pins-grid">
          {filteredPins.map((pin) => {
            const photoUrl = resolvePhotoUrl(pin);
            return (
              <button
                key={pin.id}
                type="button"
                className="pin-card"
                onClick={() => handleSelect(pin)}
              >
                {photoUrl && (
                  <div className="pin-card-photo">
                    <img src={photoUrl} alt={pin.title} />
                  </div>
                )}
                <div className="pin-card-body">
                  <div className="pin-card-top">
                    <h3>{pin.title}</h3>
                    <span className={`pin-kind-badge pin-kind-${pin.kind}`}>
                      {KIND_LABELS[pin.kind]}
                    </span>
                  </div>
                  {pin.note && <p className="pin-card-note">{pin.note}</p>}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
