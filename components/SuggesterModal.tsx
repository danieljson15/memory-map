"use client";

import { useEffect, useState } from "react";
import LiquidGlass from "liquid-glass-react";
import type {
  RankedWishlistPin,
  Suggestion,
  SuggestionStep,
} from "@/shared/api-types";

interface SuggesterModalProps {
  onClose: () => void;
}

type ViewState = "form" | "loading" | "result" | "error";

const STEP_REVEAL_DELAY_MS = 550;

export default function SuggesterModal({ onClose }: SuggesterModalProps) {
  const [view, setView] = useState<ViewState>("form");
  const [budget, setBudget] = useState("");
  const [departureAirport, setDepartureAirport] = useState("");
  const [travelMonth, setTravelMonth] = useState("");
  const [nights, setNights] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [steps, setSteps] = useState<SuggestionStep[]>([]);
  const [candidates, setCandidates] = useState<RankedWishlistPin[]>([]);
  const [visibleStepCount, setVisibleStepCount] = useState(0);

  // The backend returns a complete result in one call rather than
  // streaming (see lib/suggester.ts) — revealing steps one at a time with
  // a short delay fakes that effect client-side, per the brief.
  useEffect(() => {
    if (view !== "result" || visibleStepCount >= steps.length) return;
    const timeout = setTimeout(() => {
      setVisibleStepCount((n) => n + 1);
    }, STEP_REVEAL_DELAY_MS);
    return () => clearTimeout(timeout);
  }, [view, visibleStepCount, steps.length]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setView("loading");

    try {
      const res = await fetch("/api/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          budget: Number(budget),
          departure_airport: departureAirport.trim(),
          travel_month: travelMonth.trim(),
          nights: Number(nights),
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Something went wrong.");
      }

      setSuggestion(data.suggestion as Suggestion);
      setSteps((data.steps as SuggestionStep[]) || []);
      setCandidates((data.candidates as RankedWishlistPin[]) || []);
      setVisibleStepCount(0);
      setView("result");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Something went wrong.";
      setError(message);
      setView("error");
    }
  }

  function handleReset() {
    setView("form");
    setSuggestion(null);
    setSteps([]);
    setCandidates([]);
    setVisibleStepCount(0);
    setError(null);
  }

  const isFromWishlist =
    !!suggestion?.destination &&
    candidates.some(
      (c) => c.title.toLowerCase() === suggestion.destination!.toLowerCase(),
    );

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <LiquidGlass
        className="suggester-card"
        padding="1.75rem"
        cornerRadius={22}
        displacementScale={50}
        aberrationIntensity={1}
        overLight
      >
        {view === "form" && (
          <form onSubmit={handleSubmit}>
            <h2>Suggest a trip</h2>

            <div className="field">
              <label htmlFor="budget">Budget (EUR)</label>
              <input
                id="budget"
                type="number"
                min="0"
                required
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                placeholder="e.g. 800"
              />
            </div>

            <div className="field">
              <label htmlFor="departure_airport">Departure airport</label>
              <input
                id="departure_airport"
                type="text"
                required
                value={departureAirport}
                onChange={(e) => setDepartureAirport(e.target.value)}
                placeholder="e.g. CPH"
              />
            </div>

            <div className="field">
              <label htmlFor="travel_month">Month</label>
              <input
                id="travel_month"
                type="text"
                required
                value={travelMonth}
                onChange={(e) => setTravelMonth(e.target.value)}
                placeholder="e.g. September"
              />
            </div>

            <div className="field">
              <label htmlFor="nights">Nights</label>
              <input
                id="nights"
                type="number"
                min="1"
                required
                value={nights}
                onChange={(e) => setNights(e.target.value)}
                placeholder="e.g. 5"
              />
            </div>

            <div className="modal-actions">
              <button type="button" className="ghost-btn" onClick={onClose}>
                Cancel
              </button>
              <button className="primary-btn" type="submit">
                Get suggestion
              </button>
            </div>
          </form>
        )}

        {view === "loading" && (
          <div className="suggester-loading">
            <h2>Suggest a trip</h2>
            <p>Thinking through your travel history and budget…</p>
          </div>
        )}

        {view === "error" && (
          <div>
            <h2>Suggest a trip</h2>
            <p className="error-text">{error}</p>
            <div className="modal-actions">
              <button type="button" className="ghost-btn" onClick={onClose}>
                Close
              </button>
              <button
                className="primary-btn"
                type="button"
                onClick={handleReset}
              >
                Try again
              </button>
            </div>
          </div>
        )}

        {view === "result" && suggestion && (
          <div>
            <h2>{suggestion.destination}</h2>
            <p className="suggester-badge">
              {isFromWishlist
                ? "From your wishlist"
                : "New idea — not on your wishlist yet"}
            </p>

            {candidates.length > 0 && (
              <div className="candidates-list">
                <p className="candidates-label">
                  Ranked by similarity to your travel history
                </p>
                {candidates.map((c) => {
                  const isChosen =
                    c.title.toLowerCase() ===
                    suggestion.destination?.toLowerCase();
                  return (
                    <div
                      key={c.id}
                      className={
                        isChosen
                          ? "candidate-row candidate-chosen"
                          : "candidate-row"
                      }
                    >
                      <span>{c.title}</span>
                      <span className="candidate-similarity">
                        {Math.round(c.similarity * 100)}% match
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            {suggestion.cost_breakdown && (
              <div className="cost-breakdown">
                <div>
                  <span>Flights</span>
                  <span>€{suggestion.cost_breakdown.flights}</span>
                </div>
                <div>
                  <span>Lodging</span>
                  <span>€{suggestion.cost_breakdown.lodging}</span>
                </div>
                <div>
                  <span>Food</span>
                  <span>€{suggestion.cost_breakdown.food}</span>
                </div>
                <div>
                  <span>Activities</span>
                  <span>€{suggestion.cost_breakdown.activities}</span>
                </div>
                <div className="cost-total">
                  <span>Total</span>
                  <span>€{suggestion.total_cost}</span>
                </div>
              </div>
            )}

            <p className="suggester-steps-label">Reasoning</p>
            <ul className="suggester-steps">
              {steps.slice(0, visibleStepCount).map((step, i) => (
                <li key={step.id} className="suggester-step">
                  <span className="suggester-step-index">{i + 1}</span>
                  <span>
                    {"text" in step.content
                      ? step.content.text
                      : JSON.stringify(step.content)}
                  </span>
                </li>
              ))}
            </ul>

            <div className="modal-actions">
              <button type="button" className="ghost-btn" onClick={onClose}>
                Close
              </button>
              <button
                className="primary-btn"
                type="button"
                onClick={handleReset}
              >
                New suggestion
              </button>
            </div>
          </div>
        )}
      </LiquidGlass>
    </div>
  );
}
