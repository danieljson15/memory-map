"use client";

import { useState } from "react";
import LiquidGlass from "liquid-glass-react";
import { PRICE_TIER_LABELS, type PriceTier } from "@/lib/budget";
import type { NearbyRecommendation } from "@/shared/api-types";

interface NearbyRecommendationsModalProps {
  center: { lat: number; lng: number };
  // Browsing/searching is public; only saving a result as a pin is
  // owner-only (writes remain owner-gated, see CLAUDE.md). Passed down
  // rather than re-derived so the Save button can tell a signed-out
  // visitor upfront instead of letting the save request 403.
  isOwner: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export default function NearbyRecommendationsModal({
  center,
  isOwner,
  onClose,
  onSaved,
}: NearbyRecommendationsModalProps) {
  const [radius, setRadius] = useState("8000");
  const [maxPriceTier, setMaxPriceTier] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recommendations, setRecommendations] = useState<
    NearbyRecommendation[]
  >([]);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [savingId, setSavingId] = useState<string | null>(null);

  async function findRecommendations() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/recommendations/nearby", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lat: center.lat,
          lng: center.lng,
          radius_meters: Number(radius),
          max_price_tier: maxPriceTier ? Number(maxPriceTier) : undefined,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to find recommendations");
      }
      setRecommendations(data.recommendations as NearbyRecommendation[]);
    } catch (searchError) {
      setError(
        searchError instanceof Error
          ? searchError.message
          : "Failed to find recommendations",
      );
    } finally {
      setLoading(false);
    }
  }

  async function saveToWishlist(place: NearbyRecommendation) {
    setSavingId(place.place_id);
    setError(null);
    try {
      const response = await fetch("/api/pins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "wishlist",
          lat: place.lat,
          lng: place.lng,
          title: place.name,
          note: place.explanation,
          place_provider: "google",
          external_place_id: place.place_id,
          // Persisted only because the owner explicitly saved this result;
          // the owners can change it afterwards. See CLAUDE.md on which
          // Google-derived fields are allowed to become durable.
          price_tier: place.price_tier ?? undefined,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Failed to save place");
      setSavedIds((current) => new Set(current).add(place.place_id));
      onSaved();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save place");
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div
      className="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <LiquidGlass
        className="recommendations-card"
        padding="1.75rem"
        cornerRadius={22}
        displacementScale={45}
        aberrationIntensity={1}
        overLight
      >
        <div className="recommendations-header">
          <div>
            <h2>Recommend places nearby</h2>
            <p>Rank real places around the current map center by your memories.</p>
          </div>
          <button type="button" className="icon-close-btn" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="recommendations-controls">
          <label htmlFor="recommendation-radius">Search radius</label>
          <select
            id="recommendation-radius"
            value={radius}
            onChange={(event) => setRadius(event.target.value)}
            disabled={loading}
          >
            <option value="3000">3 km</option>
            <option value="8000">8 km</option>
            <option value="15000">15 km</option>
            <option value="30000">30 km</option>
          </select>
          <label htmlFor="recommendation-budget">Budget</label>
          <select
            id="recommendation-budget"
            value={maxPriceTier}
            onChange={(event) => setMaxPriceTier(event.target.value)}
            disabled={loading}
          >
            <option value="">Any price</option>
            {([1, 2, 3, 4] as PriceTier[]).map((tier) => (
              <option key={tier} value={tier}>
                Up to {"€".repeat(tier)} — {PRICE_TIER_LABELS[tier]}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="primary-btn"
            disabled={loading}
            onClick={() => void findRecommendations()}
          >
            {loading ? "Finding matches…" : "Find recommendations"}
          </button>
        </div>

        {error && <p className="error-text recommendation-error">{error}</p>}

        {!loading && recommendations.length === 0 && !error && (
          <p className="recommendations-empty">
            Center the map on a city, then find places that match your taste.
          </p>
        )}

        {recommendations.length > 0 && (
          <div className="recommendations-list">
            {recommendations.map((place) => {
              const saved = savedIds.has(place.place_id);
              return (
                <article key={place.place_id} className="recommendation-row">
                  <div className="recommendation-copy">
                    <div className="recommendation-title-row">
                      <h3>{place.name}</h3>
                      <span>{Math.round(place.score * 100)}% match</span>
                    </div>
                    <p className="recommendation-address">{place.address}</p>
                    <p className="recommendation-reason">{place.explanation}</p>
                    <div className="recommendation-meta">
                      {place.rating && <span>★ {place.rating.toFixed(1)}</span>}
                      {place.price_tier && (
                        <span>{"€".repeat(place.price_tier)}</span>
                      )}
                      <span>{(place.distance_meters / 1000).toFixed(1)} km away</span>
                      {place.google_maps_uri && (
                        <a
                          href={place.google_maps_uri}
                          target="_blank"
                          rel="noreferrer"
                        >
                          View on Google Maps
                        </a>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="save-place-btn"
                    disabled={!isOwner || saved || savingId !== null}
                    title={isOwner ? undefined : "Sign in as an owner to save"}
                    onClick={() => void saveToWishlist(place)}
                  >
                    {!isOwner
                      ? "Sign in to save"
                      : saved
                        ? "Saved"
                        : savingId === place.place_id
                          ? "Saving…"
                          : "Save"}
                  </button>
                </article>
              );
            })}
            <p className="google-attribution recommendations-attribution">
              Place information provided by Google Maps
            </p>
          </div>
        )}
      </LiquidGlass>
    </div>
  );
}
