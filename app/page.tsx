"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
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
      <header className="topbar">
        <h1 className="brand">
          Memory <span className="brand-mark">Map</span>
        </h1>
        <button
          className="signout-btn"
          onClick={() => supabase.auth.signOut()}
        >
          Sign out
        </button>
      </header>

      <main className="map-stage">
        <div className="map-frame">
          <MapView userId={session.user.id} />
        </div>
      </main>
    </div>
  );
}
