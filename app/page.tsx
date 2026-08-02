"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import LiquidGlass from "liquid-glass-react";
import { supabase } from "@/lib/supabaseClient";
import AuthScreen from "@/components/AuthScreen";

// Leaflet touches `window` on import, so the map can only render client-side.
const MapView = dynamic(() => import("@/components/MapView"), {
  ssr: false,
});

export default function Home() {
  const [session, setSession] = useState<Session | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setCheckingSession(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, newSession) => {
        setSession(newSession);
      },
    );

    return () => {
      listener.subscription.unsubscribe();
    };
  }, []);

  if (checkingSession) {
    return <div className="loading-screen">Loading Memory Map...</div>;
  }

  if (!session) {
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
            onClick={() => supabase.auth.signOut()}
          >
            Sign out
          </button>
        </div>
      </LiquidGlass>

      <main className="map-stage">
        <div className="map-frame">
          <MapView userId={session.user.id} />
        </div>
      </main>
    </div>
  );
}
