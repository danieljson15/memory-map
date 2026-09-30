"use client";

import { useEffect, useMemo, useState } from "react";
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

interface AllPinsModalProps {
  onClose: () => void;
  onSelectPin: (pinId: string) => void;
}

// Replaces the old standalone /pins route with a modal over the already-
// mounted map, so it gets the blurred-map-behind treatment other modals
// have via .modal-backdrop's own backdrop-filter — no second map load,
// unlike keeping /pins as its own route would have required. The list
// itself stays flat (no LiquidGlass), matching CLAUDE.md's existing
// "dense content stays flat" rule; only the surrounding backdrop blurs.
export default function AllPinsModal({ onClose, onSelectPin }: AllPinsModalProps) {
  const [pins, setPins] = useState<PinWithPhotos[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function loadPins() {
      try {
        const res = await fetch("/api/pins");
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to load pins");
        if (!cancelled) setPins(data.pins as PinWithPhotos[]);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load pins");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void loadPins();
    return () => {
      cancelled = true;
    };
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

  const emptyMessage =
    pins.length === 0
      ? "No pins yet"
      : kindFilter === "memory"
        ? "No memories yet"
        : kindFilter === "wishlist"
          ? "No wishlist pins yet"
          : "No pins match your search";

  return (
    <div
      className="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="all-pins-card">
        <div className="pins-header">
          <h1>All pins</h1>
          <button type="button" className="icon-close-btn" onClick={onClose}>
            ×
          </button>
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
                  onClick={() => onSelectPin(pin.id)}
                >
                  {photoUrl && (
                    <div className="pin-card-photo">
                      {/* Supabase Storage hosts user uploads on a project-specific
                          runtime domain, so a plain image avoids an unsafe wildcard
                          remote-image configuration in next.config.js. */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
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
                    {(pin.user_rating || pin.tags.length > 0) && (
                      <p className="pin-card-meta">
                        {[
                          pin.user_rating ? `★ ${pin.user_rating}/5` : null,
                          pin.tags.length > 0 ? pin.tags.join(" · ") : null,
                        ]
                          .filter(Boolean)
                          .join("  ·  ")}
                      </p>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
