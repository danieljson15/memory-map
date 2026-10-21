import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { fakeDb } from "../helpers";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  getOwnerAccess: vi.fn(),
  checkRateLimit: vi.fn(),
  autocomplete: vi.fn(),
  details: vi.fn(),
  admit: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: mocks.createClient }));
vi.mock("@/lib/api-auth", () => ({ getOwnerAccess: mocks.getOwnerAccess }));
vi.mock("@/lib/rate-limit", async (orig) => ({
  ...(await orig<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: mocks.checkRateLimit,
}));
vi.mock("@/lib/google-places", () => ({
  autocompletePlaces: mocks.autocomplete,
  getPlaceDetails: mocks.details,
}));
vi.mock("@/lib/usage", async (orig) => ({
  ...(await orig<typeof import("@/lib/usage")>()),
  admitGoogleApiUsage: mocks.admit,
}));

import { POST as autocomplete } from "@/app/api/places/autocomplete/route";
import { GET as details } from "@/app/api/places/details/route";
import { UsageLimitError } from "@/lib/usage";

const owner = { user: { id: "o" }, error: null, status: 200 };
const anon = { user: null, error: "Not signed in", status: 401 };
const place = { place_id: "p1", name: "Blue Bottle", lat: 1, lng: 2 };

const search = (body: unknown) =>
  autocomplete(
    new NextRequest("http://x/api/places/autocomplete", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "x-forwarded-for": "9.9.9.9" },
    }),
  );
const lookup = (qs: string) => details(new NextRequest(`http://x/api/places/details?${qs}`));
const validSearch = { input: "blue bottle", session_token: "tok" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createClient.mockResolvedValue(fakeDb().client);
  mocks.getOwnerAccess.mockResolvedValue(anon);
  mocks.checkRateLimit.mockResolvedValue({ admitted: true, retryAfterSeconds: 0 });
  mocks.admit.mockResolvedValue({ admitted: true });
  mocks.autocomplete.mockResolvedValue([{ place_id: "p1", main_text: "Blue Bottle" }]);
  // Mirrors the real getPlaceDetails: the usage gate runs only on a cache miss.
  mocks.details.mockImplementation(
    async (_s: unknown, _id: string, _t: unknown, gate: () => Promise<boolean>) => {
      if (!(await gate())) throw new UsageLimitError();
      return place;
    },
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/places/autocomplete", () => {
  it("works without signing in and returns predictions", async () => {
    const res = await search(validSearch);
    expect(res.status).toBe(200);
    expect((await res.json()).predictions).toHaveLength(1);
  });

  it("rate limits anonymous callers per client, before spending any quota", async () => {
    mocks.checkRateLimit.mockResolvedValue({ admitted: false, retryAfterSeconds: 3600 });
    const res = await search(validSearch);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("3600");
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(expect.anything(), "PUBLIC_SEARCH", "9.9.9.9");
    expect(mocks.admit).not.toHaveBeenCalled();
    expect(mocks.autocomplete).not.toHaveBeenCalled();
  });

  it("meters anonymous search on its own counter, not the owners' or the demo's", async () => {
    await search(validSearch);
    expect(mocks.admit).toHaveBeenCalledWith(expect.anything(), "public_search_request");
  });

  it("owners skip the rate limit and keep their own counter", async () => {
    mocks.getOwnerAccess.mockResolvedValue(owner);
    await search(validSearch);
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(mocks.admit).toHaveBeenCalledWith(expect.anything(), "places_request");
  });

  it("503s without calling Google once the monthly public budget is spent", async () => {
    mocks.admit.mockResolvedValue({ admitted: false });
    const res = await search(validSearch);
    expect(res.status).toBe(503);
    expect(mocks.autocomplete).not.toHaveBeenCalled();
  });

  it.each([
    ["short input", { ...validSearch, input: "ab" }],
    ["overlong input", { ...validSearch, input: "x".repeat(201) }],
    ["missing session token", { input: "blue bottle" }],
  ])("400s on %s without counting it against the budget", async (_n, body) => {
    expect((await search(body)).status).toBe(400);
    expect(mocks.admit).not.toHaveBeenCalled();
  });

  it("502s with a generic message that doesn't leak Google's error body", async () => {
    mocks.autocomplete.mockRejectedValue(new Error("Google said: key=SECRET123"));
    const res = await search(validSearch);
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain("SECRET123");
  });
});

describe("GET /api/places/details", () => {
  it("works without signing in", async () => {
    const res = await lookup("place_id=p1&session_token=tok");
    expect(res.status).toBe(200);
    expect((await res.json()).place).toEqual(place);
  });

  it("shares the PUBLIC_SEARCH bucket and counter with autocomplete", async () => {
    await lookup("place_id=p1");
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(expect.anything(), "PUBLIC_SEARCH", expect.any(String));
    expect(mocks.admit).toHaveBeenCalledWith(expect.anything(), "public_search_request");
  });

  it("429s anonymous callers over the limit without looking anything up", async () => {
    mocks.checkRateLimit.mockResolvedValue({ admitted: false, retryAfterSeconds: 3600 });
    expect((await lookup("place_id=p1")).status).toBe(429);
    expect(mocks.details).not.toHaveBeenCalled();
  });

  it("owners use their own counter with no rate limit", async () => {
    mocks.getOwnerAccess.mockResolvedValue(owner);
    await lookup("place_id=p1");
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(mocks.admit).toHaveBeenCalledWith(expect.anything(), "places_request");
  });

  it("503s when the usage limit is hit on a cache miss", async () => {
    mocks.admit.mockResolvedValue({ admitted: false });
    expect((await lookup("place_id=p1")).status).toBe(503);
  });

  it("400s on a missing place_id", async () => {
    expect((await lookup("session_token=tok")).status).toBe(400);
  });
});
