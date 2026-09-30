"use client";

import { useEffect, useState } from "react";
import type { MapProvider, MapsConfigResponse } from "@/shared/api-types";
import GoogleMapView, { type MapViewProps } from "./GoogleMapView";
import LeafletMapView from "./LeafletMapView";

// Decides which map to render *before* either implementation mounts —
// specifically before GoogleMapView ever requests the Google Maps JS SDK
// — by asking the server whether this month's usage allowance is spent
// (see /api/maps-config and lib/usage.ts). An over-allowance visitor
// never triggers a billable Google Maps load at all, not even a failed
// one; they just get the Leaflet/OSM fallback showing the same saved
// pins.
export default function MapView(props: MapViewProps) {
  const [provider, setProvider] = useState<MapProvider | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadConfig() {
      try {
        const response = await fetch("/api/maps-config", { cache: "no-store" });
        const data = (await response.json()) as MapsConfigResponse;
        if (!cancelled) setProvider(response.ok ? data.provider : "leaflet");
      } catch {
        // Network/parse failure — degrade to the free fallback rather
        // than risk an unmetered Google load on an uncertain response.
        if (!cancelled) setProvider("leaflet");
      }
    }
    void loadConfig();
    return () => {
      cancelled = true;
    };
  }, []);

  if (provider === null) {
    return <div className="google-map" aria-label="Memory Map" />;
  }

  return provider === "google" ? (
    <GoogleMapView {...props} />
  ) : (
    <LeafletMapView {...props} />
  );
}
