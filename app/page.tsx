"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import LiquidGlass from "liquid-glass-react";
import { supabase } from "@/lib/supabaseClient";
import AuthScreen from "@/components/AuthScreen";
import SuggesterModal from "@/components/SuggesterModal";

// Leaflet touches `window` on import, so the map can only render client-side.
const MapView = dynamic(() => import("@/components/MapView"), {
  ssr: false,
});

export default function Home() {
  const [session, setSession] = useState<Session | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [showAuth, setShowAuth] = useState(false);
  const [showSuggester, setShowSuggester] = useState(false);

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
          <Link href="/pins" className="signout-btn">
            All pins
          </Link>
          {session ? (
            <>
              <button
                className="suggest-trip-btn"
                onClick={() => setShowSuggester(true)}
              >
                ✨ Suggest a trip
              </button>
              <button
                className="signout-btn"
                onClick={() => supabase.auth.signOut()}
              >
                Sign out
              </button>
            </>
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
          <MapView userId={session?.user.id} />
        </div>
      </main>

      {showSuggester && session && (
        <SuggesterModal onClose={() => setShowSuggester(false)} />
      )}
    </div>
  );
}
