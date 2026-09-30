"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import LiquidGlass from "liquid-glass-react";
import { supabase } from "@/lib/supabaseClient";
import AuthScreen from "@/components/AuthScreen";
import SuggesterModal from "@/components/SuggesterModal";
import NearbyRecommendationsModal from "@/components/NearbyRecommendationsModal";
import AllPinsModal from "@/components/AllPinsModal";

// ssr: false because MapView can render LeafletMapView (see
// components/MapView.tsx and lib/usage.ts), and Leaflet touches `window`
// at import time — it always crashed server-side prerendering, Google
// Maps or not, which is why this was already dynamic before the Google
// refactor.
const MapView = dynamic(() => import("@/components/MapView"), {
  ssr: false,
});

export default function Home() {
  const [session, setSession] = useState<Session | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [showAuth, setShowAuth] = useState(false);
  const [showSuggester, setShowSuggester] = useState(false);
  const [isOwner, setIsOwner] = useState(false);
  const [showNearbyRecommendations, setShowNearbyRecommendations] =
    useState(false);
  const [showAllPins, setShowAllPins] = useState(false);
  const [mapCenter, setMapCenter] = useState({ lat: 50.5, lng: 10.5 });
  const [pinsRefreshToken, setPinsRefreshToken] = useState(0);
  // Seeded once from ?pin= on first load so an old /?pin=<id> link (or a
  // freshly-selected pin from AllPinsModal) both focus the same way,
  // through the same prop rather than MapView reading the URL itself.
  const [focusPinId, setFocusPinId] = useState<string | null>(() =>
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("pin"),
  );

  useEffect(() => {
    supabase.auth
      .getSession()
      .then(({ data }) => {
        setSession(data.session);
      })
      .catch((err) => {
        // The map is public-read now — there's no reason a failed session
        // check should block anyone from seeing it. Treat it as "signed
        // out" rather than hanging on the loading screen forever with no
        // feedback (which is what happened before this .catch existed).
        console.error("Failed to check auth session:", err);
        setSession(null);
      })
      .finally(() => {
        setCheckingSession(false);
      });

    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, newSession) => {
        setSession(newSession);
        if (newSession) setShowAuth(false);
      },
    );

    return () => {
      listener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!session) {
      setIsOwner(false);
      return;
    }

    async function checkOwnerAccess() {
      try {
        const { data, error } = await supabase.rpc("is_memory_map_owner");
        if (!cancelled) setIsOwner(!error && data === true);
      } catch {
        if (!cancelled) setIsOwner(false);
      }
    }
    void checkOwnerAccess();

    return () => {
      cancelled = true;
    };
  }, [session]);

  if (checkingSession) {
    return <div className="loading-screen">Loading Memory Map...</div>;
  }

  if (!session && showAuth) {
    return <AuthScreen />;
  }

  return (
    <div className="shell">
      {/* LiquidGlass's visible surface always sizes to its content (no
          full-width/stretch mode) and centers itself on an explicit
          top/left anchor via its own translate(-50%,-50%) transform, so
          this renders as a compact floating pill rather than an edge-to-edge
          bar — top/left below describe its center point, not its corner. */}
      <LiquidGlass
        className="topbar"
        style={{ position: "absolute", top: "3rem", left: "50%", zIndex: 20 }}
        padding="14px 24px"
        cornerRadius={22}
        displacementScale={40}
        aberrationIntensity={1}
        overLight
      >
        <div className="topbar-inner">
          <h1 className="brand">
            Memory <span className="brand-mark">Map</span>
          </h1>
          <button
            className="signout-btn"
            onClick={() => setShowAllPins(true)}
          >
            All pins
          </button>
          <button
            className="signout-btn"
            onClick={() => setShowSuggester(true)}
          >
            Suggest a trip
          </button>
          <button
            className="signout-btn"
            onClick={() => setShowNearbyRecommendations(true)}
          >
            Recommend nearby
          </button>
          {session ? (
            <button
              className="signout-btn"
              onClick={() => supabase.auth.signOut()}
            >
              Sign out
            </button>
          ) : (
            <button
              className="signout-btn"
              onClick={() => setShowAuth(true)}
            >
              Sign in
            </button>
          )}
        </div>
      </LiquidGlass>

      <main className="map-stage">
        <div className="map-frame">
          <MapView
            userId={isOwner ? session?.user.id : undefined}
            refreshToken={pinsRefreshToken}
            onCenterChange={setMapCenter}
            focusPinId={focusPinId}
          />
        </div>
      </main>

      {showSuggester && (
        <SuggesterModal
          center={mapCenter}
          isOwner={!!session && isOwner}
          onClose={() => setShowSuggester(false)}
        />
      )}
      {showNearbyRecommendations && (
        <NearbyRecommendationsModal
          center={mapCenter}
          isOwner={!!session && isOwner}
          onClose={() => setShowNearbyRecommendations(false)}
          onSaved={() => setPinsRefreshToken((token) => token + 1)}
        />
      )}
      {showAllPins && (
        <AllPinsModal
          onClose={() => setShowAllPins(false)}
          onSelectPin={(pinId) => {
            setFocusPinId(pinId);
            setShowAllPins(false);
          }}
        />
      )}
    </div>
  );
}
