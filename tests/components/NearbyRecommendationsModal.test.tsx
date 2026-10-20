// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NearbyRecommendation } from "@/shared/api-types";

// liquid-glass-react relies on SVG filters/layout the DOM test environment lacks; a
// passthrough keeps the test about this component's behavior.
vi.mock("liquid-glass-react", () => ({
  default: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));

import NearbyRecommendationsModal from "@/components/NearbyRecommendationsModal";

const rec = (over: Partial<NearbyRecommendation> = {}): NearbyRecommendation => ({
  place_id: "p1",
  name: "Blue Bottle",
  address: "1 Main St",
  lat: 1,
  lng: 2,
  primary_type: "cafe",
  types: [],
  google_maps_uri: "https://maps.google.com/?cid=1",
  rating: 4.6,
  rating_count: 200,
  price_level: "PRICE_LEVEL_MODERATE",
  price_tier: 2,
  distance_meters: 1500,
  similarity: 0.9,
  score: 0.87,
  explanation: "Matches your taste",
  ...over,
});

const fetchMock = vi.fn();
const json = (ok: boolean, body: unknown) => ({ ok, json: async () => body });
const center = { lat: 10, lng: 20 };

function renderModal(props: Partial<React.ComponentProps<typeof NearbyRecommendationsModal>> = {}) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(
    <NearbyRecommendationsModal center={center} isOwner onClose={onClose} onSaved={onSaved} {...props} />,
  );
  return { onClose, onSaved, user: userEvent.setup() };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("NearbyRecommendationsModal", () => {
  it("shows the empty prompt before any search", () => {
    renderModal();
    expect(screen.getByText(/Center the map on a city/)).toBeInTheDocument();
  });

  it("sends the map center, selected radius, and budget tier to the API", async () => {
    fetchMock.mockResolvedValue(json(true, { recommendations: [] }));
    const { user } = renderModal();
    await user.selectOptions(screen.getByLabelText("Search radius"), "15000");
    await user.selectOptions(screen.getByLabelText("Budget"), "2");
    await user.click(screen.getByRole("button", { name: "Find recommendations" }));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/recommendations/nearby");
    expect(JSON.parse(init.body)).toEqual({ lat: 10, lng: 20, radius_meters: 15000, max_price_tier: 2 });
  });

  it("omits max_price_tier when 'Any price' is selected", async () => {
    fetchMock.mockResolvedValue(json(true, { recommendations: [] }));
    const { user } = renderModal();
    await user.click(screen.getByRole("button", { name: "Find recommendations" }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).max_price_tier).toBeUndefined();
  });

  it("disables controls and shows progress while loading", async () => {
    let resolve!: (v: unknown) => void;
    fetchMock.mockReturnValue(new Promise((r) => (resolve = r)));
    const { user } = renderModal();
    await user.click(screen.getByRole("button", { name: "Find recommendations" }));
    expect(screen.getByRole("button", { name: "Finding matches…" })).toBeDisabled();
    expect(screen.getByLabelText("Search radius")).toBeDisabled();
    resolve(json(true, { recommendations: [] }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Find recommendations" })).toBeEnabled());
  });

  it("renders results with match %, price, distance, link and Google attribution", async () => {
    fetchMock.mockResolvedValue(json(true, { recommendations: [rec()] }));
    const { user } = renderModal();
    await user.click(screen.getByRole("button", { name: "Find recommendations" }));

    expect(await screen.findByText("Blue Bottle")).toBeInTheDocument();
    expect(screen.getByText("87% match")).toBeInTheDocument();
    expect(screen.getByText("€€")).toBeInTheDocument();
    expect(screen.getByText("1.5 km away")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View on Google Maps" })).toHaveAttribute(
      "href",
      "https://maps.google.com/?cid=1",
    );
    expect(screen.getByText(/provided by Google Maps/)).toBeInTheDocument();
  });

  it("surfaces the server's error message (e.g. 429)", async () => {
    fetchMock.mockResolvedValue(json(false, { error: "Too many requests — try again later." }));
    const { user } = renderModal();
    await user.click(screen.getByRole("button", { name: "Find recommendations" }));
    expect(await screen.findByText("Too many requests — try again later.")).toBeInTheDocument();
  });

  it("shows a network failure instead of crashing", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    const { user } = renderModal();
    await user.click(screen.getByRole("button", { name: "Find recommendations" }));
    expect(await screen.findByText("offline")).toBeInTheDocument();
  });

  describe("saving", () => {
    async function withResult(isOwner: boolean) {
      fetchMock.mockResolvedValueOnce(json(true, { recommendations: [rec()] }));
      const ctx = renderModal({ isOwner });
      await ctx.user.click(screen.getByRole("button", { name: "Find recommendations" }));
      await screen.findByText("Blue Bottle");
      return ctx;
    }

    it("non-owners see a disabled 'Sign in to save' and can never trigger a write", async () => {
      const { user } = await withResult(false);
      const button = screen.getByRole("button", { name: "Sign in to save" });
      expect(button).toBeDisabled();
      await user.click(button);
      expect(fetchMock).toHaveBeenCalledTimes(1); // only the search
    });

    it("owners save as a wishlist pin carrying the Google place id and price tier", async () => {
      const { user, onSaved } = await withResult(true);
      fetchMock.mockResolvedValueOnce(json(true, { pin: {} }));
      await user.click(screen.getByRole("button", { name: "Save" }));

      const [url, init] = fetchMock.mock.calls[1];
      expect(url).toBe("/api/pins");
      expect(JSON.parse(init.body)).toMatchObject({
        kind: "wishlist",
        title: "Blue Bottle",
        place_provider: "google",
        external_place_id: "p1",
        price_tier: 2,
        note: "Matches your taste",
      });
      expect(await screen.findByRole("button", { name: "Saved" })).toBeDisabled();
      expect(onSaved).toHaveBeenCalledTimes(1);
    });

    it("keeps Save available and shows the error if saving fails", async () => {
      const { user, onSaved } = await withResult(true);
      fetchMock.mockResolvedValueOnce(json(false, { error: "Only the two owner accounts can make changes." }));
      await user.click(screen.getByRole("button", { name: "Save" }));
      expect(await screen.findByText(/Only the two owner accounts/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
      expect(onSaved).not.toHaveBeenCalled();
    });
  });

  describe("closing", () => {
    it("closes from the × button", async () => {
      const { user, onClose } = renderModal();
      await user.click(screen.getByRole("button", { name: "×" }));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("closes on backdrop click but not on clicks inside the card", async () => {
      const { user, onClose } = renderModal();
      await user.click(screen.getByText("Recommend places nearby"));
      expect(onClose).not.toHaveBeenCalled();
      await user.click(document.querySelector(".modal-backdrop")!);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
