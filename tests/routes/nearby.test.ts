import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { fakeDb, place } from "../helpers";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  getOwnerAccess: vi.fn(),
  checkRateLimit: vi.fn(),
  search: vi.fn(),
  admit: vi.fn(),
  getEmbedding: vi.fn(),
  getEmbeddings: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: mocks.createClient }));
vi.mock("@/lib/api-auth", () => ({ getOwnerAccess: mocks.getOwnerAccess }));
vi.mock("@/lib/rate-limit", async (orig) => ({
  ...(await orig<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: mocks.checkRateLimit,
}));
vi.mock("@/lib/google-places", () => ({ searchNearbyPlaces: mocks.search }));
vi.mock("@/lib/usage", async (orig) => ({
  ...(await orig<typeof import("@/lib/usage")>()),
  admitGoogleApiUsage: mocks.admit,
}));
vi.mock("@/lib/embeddings", () => ({
  getEmbedding: mocks.getEmbedding,
  getEmbeddings: mocks.getEmbeddings,
}));

import { POST } from "@/app/api/recommendations/nearby/route";
import { UsageLimitError } from "@/lib/usage";

const call = (body: unknown) =>
  POST(new NextRequest("http://x/api/recommendations/nearby", { method: "POST", body: JSON.stringify(body) }));
const valid = { lat: 38, lng: -78 };
const owner = { user: { id: "o" }, error: null, status: 200 };
const anon = { user: null, error: "Not signed in", status: 401 };

function setup(memories: unknown[] | null, saved: unknown[] = [], memoriesError = null) {
  const calls: string[] = [];
  const db = fakeDb({ pins: { data: memories, error: memoriesError } });
  // `pins` is queried twice (memories, saved ids); answer each in order.
  const from = db.client.from;
  let n = 0;
  db.client.from = (t: string) => {
    calls.push(t);
    const chain = from(t);
    return n++ === 0 ? chain : fakeDb({ pins: { data: saved } }).client.from(t);
  };
  mocks.createClient.mockResolvedValue(db.client);
  return db;
}

const good = [{ title: "m", note: null, user_rating: 5, tags: [] }];

beforeEach(() => {
  vi.clearAllMocks();
  setup(good);
  mocks.getOwnerAccess.mockResolvedValue(anon);
  mocks.checkRateLimit.mockResolvedValue({ admitted: true, retryAfterSeconds: 0 });
  mocks.search.mockResolvedValue([place({ place_id: "a" }), place({ place_id: "b", lat: 0.001 })]);
  mocks.admit.mockResolvedValue({ admitted: true });
  mocks.getEmbedding.mockResolvedValue([1, 0]);
  mocks.getEmbeddings.mockImplementation(async (_s: unknown, texts: string[]) => texts.map(() => [1, 0]));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/recommendations/nearby — access tiers", () => {
  it("public callers are rate limited (429 + Retry-After) before any Google/Voyage work", async () => {
    mocks.checkRateLimit.mockResolvedValue({ admitted: false, retryAfterSeconds: 3600 });
    const res = await call(valid);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("3600");
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("public callers are metered on the separate public_places_request counter", async () => {
    mocks.search.mockImplementation(async (_s, _i, gate: () => Promise<boolean>) => {
      await gate();
      return [place()];
    });
    await call(valid);
    expect(mocks.admit).toHaveBeenCalledWith(expect.anything(), "public_places_request");
  });

  it("owners skip the rate limit and use their own places_request counter", async () => {
    mocks.getOwnerAccess.mockResolvedValue(owner);
    mocks.search.mockImplementation(async (_s, _i, gate: () => Promise<boolean>) => {
      await gate();
      return [place()];
    });
    await call(valid);
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(mocks.admit).toHaveBeenCalledWith(expect.anything(), "places_request");
  });
});

describe("POST /api/recommendations/nearby — validation", () => {
  it.each([
    ["missing lat", { lng: 1 }],
    ["lat > 90", { lat: 91, lng: 0 }],
    ["lng < -180", { lat: 0, lng: -181 }],
    ["tier 0", { ...valid, max_price_tier: 0 }],
    ["tier 5", { ...valid, max_price_tier: 5 }],
  ])("400s on %s", async (_n, body) => {
    expect((await call(body)).status).toBe(400);
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it.each([
    [100, 500],
    [8000, 8000],
    [999_999, 50_000],
    [undefined, 8000],
    ["abc", 8000],
  ])("clamps radius %s -> %s", async (input, expected) => {
    await call({ ...valid, radius_meters: input });
    expect(mocks.search.mock.calls[0][1].radiusMeters).toBe(expected);
  });
});

describe("POST /api/recommendations/nearby — behavior", () => {
  it("422 when there are no memories", async () => {
    setup([]);
    expect((await call(valid)).status).toBe(422);
  });

  it("422 when every memory is rated below 3 (no positive taste profile)", async () => {
    setup([{ title: "bad", note: null, user_rating: 1, tags: [] }]);
    expect((await call(valid)).status).toBe(422);
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("excludes places the owners already saved", async () => {
    setup(good, [{ external_place_id: "a" }]);
    const { recommendations } = await (await call(valid)).json();
    expect(recommendations.map((r: { place_id: string }) => r.place_id)).toEqual(["b"]);
  });

  it("filters by price tier before embedding, but keeps unknown prices", async () => {
    mocks.search.mockResolvedValue([
      place({ place_id: "cheap", price_level: "PRICE_LEVEL_INEXPENSIVE" }),
      place({ place_id: "pricey", price_level: "PRICE_LEVEL_VERY_EXPENSIVE" }),
      place({ place_id: "unknown", price_level: null }),
    ]);
    const { recommendations } = await (await call({ ...valid, max_price_tier: 1 })).json();
    expect(recommendations.map((r: { place_id: string }) => r.place_id).sort()).toEqual(["cheap", "unknown"]);
    expect(mocks.getEmbeddings.mock.calls[0][1]).toHaveLength(2);
  });

  it("returns an empty list without calling Voyage when nothing survives filtering", async () => {
    mocks.search.mockResolvedValue([]);
    expect(await (await call(valid)).json()).toEqual({ recommendations: [] });
    expect(mocks.getEmbedding).not.toHaveBeenCalled();
  });

  it("only requests an avoidance embedding when there are low-rated memories", async () => {
    await call(valid);
    expect(mocks.getEmbedding).toHaveBeenCalledTimes(1);
    setup([...good, { title: "bad", note: null, user_rating: 1, tags: [] }]);
    mocks.getEmbedding.mockClear();
    await call(valid);
    expect(mocks.getEmbedding).toHaveBeenCalledTimes(2);
  });

  it("503 when the monthly Google usage limit is hit", async () => {
    mocks.search.mockRejectedValue(new UsageLimitError());
    expect((await call(valid)).status).toBe(503);
  });

  it("502 with a generic message that does not leak upstream error details", async () => {
    mocks.search.mockRejectedValue(new Error("Google said: key=SECRET123"));
    const res = await call(valid);
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain("SECRET123");
  });
});
