"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import type { Pin } from "@/lib/types";

interface PinModalProps {
  lat: number;
  lng: number;
  userId: string;
  onClose: () => void;
  onCreated: (pin: Pin) => void;
}

export default function PinModal({
  lat,
  lng,
  userId,
  onClose,
  onCreated,
}: PinModalProps) {
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
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

    setSaving(true);

    let photoUrl: string | null = null;

    try {
      if (photoFile) {
        const fileExt = photoFile.name.split(".").pop();
        const filePath = `${userId}/${Date.now()}.${fileExt}`;

        const { error: uploadError } = await supabase.storage
          .from("pin-photos")
          .upload(filePath, photoFile);

        if (uploadError) throw uploadError;

        const { data: publicUrlData } = supabase.storage
          .from("pin-photos")
          .getPublicUrl(filePath);

        photoUrl = publicUrlData.publicUrl;
      }

      const { data, error: insertError } = await supabase
        .from("pins")
        .insert({
          lat,
          lng,
          title: title.trim(),
          note: note.trim() || null,
          photo_url: photoUrl,
          created_by: userId,
        })
        .select()
        .single();

      if (insertError) throw insertError;

      onCreated(data as Pin);
      onClose();
    } catch (err) {
      const messageText =
        err instanceof Error ? err.message : "Something went wrong.";
      setError(messageText);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <h2>New memory</h2>

        <form onSubmit={handleSave}>
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
      </div>
    </div>
  );
}
