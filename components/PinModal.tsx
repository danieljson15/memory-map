"use client";

import { useState } from "react";
import LiquidGlass from "liquid-glass-react";
import { supabase } from "@/lib/supabaseClient";
import type { Pin } from "@/lib/types";
import { PRICE_TIER_LABELS, type PriceTier } from "@/lib/budget";
import type { PinKind, PlaceDetails } from "@/shared/api-types";

interface PinModalProps {
  lat: number;
  lng: number;
  userId: string;
  place?: PlaceDetails;
  onClose: () => void;
  onCreated: (pin: Pin, photoUrl?: string) => void;
}

export default function PinModal({
  lat,
  lng,
  userId,
  place,
  onClose,
  onCreated,
}: PinModalProps) {
  // Canonical Google selections prefill the name, but the saved title remains
  // editable user content. Manual map clicks start with an empty title.
  const [title, setTitle] = useState(place?.name ?? "");
  const [note, setNote] = useState("");
  const [kind, setKind] = useState<PinKind>("memory");
  const [rating, setRating] = useState("");
  const [priceTier, setPriceTier] = useState("");
  const [tags, setTags] = useState("");
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!title.trim()) {
      setError("Give this pin a title.");
      return;
    }
    if (photoFile && photoFile.size > 10 * 1024 * 1024) {
      setError("Choose a photo smaller than 10 MB.");
      return;
    }
    if (photoFile && !photoFile.type.startsWith("image/")) {
      setError("The selected file must be an image.");
      return;
    }

    setSaving(true);

    let photoPath: string | null = null;
    let photoUrl: string | undefined;
    let createdPinId: string | null = null;

    try {
      if (photoFile) {
        const fileExt = photoFile.name.split(".").pop()?.toLowerCase() || "jpg";
        const safeExtension = /^[a-z0-9]{2,5}$/.test(fileExt) ? fileExt : "jpg";
        const filePath = `${userId}/${crypto.randomUUID()}.${safeExtension}`;

        const { error: uploadError } = await supabase.storage
          .from("photos")
          .upload(filePath, photoFile);

        if (uploadError) throw uploadError;

        photoPath = filePath;
        photoUrl = supabase.storage.from("photos").getPublicUrl(filePath).data
          .publicUrl;
      }

      const pinResponse = await fetch("/api/pins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lat,
          lng,
          title: title.trim(),
          note: note.trim() || null,
          kind,
          user_rating: rating ? Number(rating) : undefined,
          price_tier: priceTier ? Number(priceTier) : undefined,
          tags: tags
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean),
          place_provider: place ? "google" : undefined,
          external_place_id: place?.place_id,
        }),
      });
      const pinResult = await pinResponse.json();
      if (!pinResponse.ok) {
        throw new Error(pinResult.error || "Failed to create pin");
      }
      const createdPin = pinResult.pin as Pin;
      createdPinId = createdPin.id;

      if (photoPath) {
        const photoResponse = await fetch(`/api/pins/${createdPin.id}/photos`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ storage_path: photoPath }),
        });
        const photoResult = await photoResponse.json();
        if (!photoResponse.ok) {
          throw new Error(photoResult.error || "Failed to attach photo");
        }
      }

      onCreated(createdPin, photoUrl);
      onClose();
    } catch (err) {
      // Compensate for a partially completed create so retrying the form
      // cannot create duplicate pins or leave unreferenced uploads behind.
      if (createdPinId) {
        await fetch(`/api/pins/${createdPinId}`, { method: "DELETE" });
      }
      if (photoPath) {
        await supabase.storage.from("photos").remove([photoPath]);
      }
      const messageText =
        err instanceof Error ? err.message : "Something went wrong.";
      setError(messageText);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <LiquidGlass
        className="modal-card"
        padding="1.75rem"
        cornerRadius={22}
        displacementScale={50}
        aberrationIntensity={1}
        overLight
      >
        <h2>New pin</h2>

        <form onSubmit={handleSave}>
          {place && (
            <p className="selected-place-summary">
              <span>{place.name}</span>
              {place.address}
            </p>
          )}

          <div className="field">
            <label htmlFor="kind">Pin type</label>
            <select
              id="kind"
              value={kind}
              onChange={(event) => setKind(event.target.value as PinKind)}
            >
              <option value="memory">Memory — I have been here</option>
              <option value="wishlist">Wishlist — I want to go</option>
            </select>
          </div>

          <div className="field">
            <label htmlFor="title">Title</label>
            <input
              id="title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Sunset in Cinque Terre"
              autoFocus
            />
          </div>

          <div className="field">
            <label htmlFor="rating">Your rating (optional)</label>
            <select
              id="rating"
              value={rating}
              onChange={(event) => setRating(event.target.value)}
            >
              <option value="">Not rated</option>
              <option value="5">5 — Loved it</option>
              <option value="4">4 — Really liked it</option>
              <option value="3">3 — It was good</option>
              <option value="2">2 — Not for me</option>
              <option value="1">1 — Disliked it</option>
            </select>
          </div>

          <div className="field">
            <label htmlFor="price-tier">Price level (optional)</label>
            <select
              id="price-tier"
              value={priceTier}
              onChange={(event) => setPriceTier(event.target.value)}
            >
              <option value="">Not set</option>
              {([1, 2, 3, 4] as PriceTier[]).map((tier) => (
                <option key={tier} value={tier}>
                  {"€".repeat(tier)} — {PRICE_TIER_LABELS[tier]}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="tags">Tags (optional, comma-separated)</label>
            <input
              id="tags"
              type="text"
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              placeholder="coffee, bakery, quiet"
            />
          </div>

          <div className="field">
            <label htmlFor="note">Note</label>
            <textarea
              id="note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What happened here, or why it's on the list"
            />
          </div>

          <div className="field">
            <label htmlFor="photo">Photo (optional)</label>
            <input
              id="photo"
              type="file"
              accept="image/*"
              onChange={(e) => setPhotoFile(e.target.files?.[0] ?? null)}
            />
          </div>

          {error && <p className="error-text">{error}</p>}

          <div className="modal-actions">
            <button
              type="button"
              className="ghost-btn"
              onClick={onClose}
              disabled={saving}
            >
              Cancel
            </button>
            <button className="primary-btn" type="submit" disabled={saving}>
              {saving ? "Saving..." : "Save pin"}
            </button>
          </div>
        </form>
      </LiquidGlass>
    </div>
  );
}
