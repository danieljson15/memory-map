import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { fakeDb } from "../helpers";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  getOwnerAccess: vi.fn(),
  checkRateLimit: vi.fn(),
  getEmbedding: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: mocks.createClient }));
vi.mock("@/lib/api-auth", () => ({ getOwnerAccess: mocks.getOwnerAccess }));
vi.mock("@/lib/rate-limit", async (orig) => ({
  ...(await orig<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: mocks.checkRateLimit,
}));
vi.mock("@/lib/embeddings", async (orig) => ({
  ...(await orig<typeof import("@/lib/embeddings")>()),
  getEmbedding: mocks.getEmbedding,
}));

import { GET, POST } from "@/app/api/pins/route";

const owner = { user: { id: "owner-1" }, error: null, status: 200 };
const notSignedIn = { user: null, error: "Not signed in", status: 401 };

const post = (body: unknown) =>
  POST(new NextRequest("http://x/api/pins", { method: "POST", body: JSON.stringify(body) }));
const validPin = { kind: "memory", lat: 10, lng: 20, title: "  Cafe  " };

let db: ReturnType<typeof fakeDb>;
beforeEach(() => {
  vi.clearAllMocks();
  db = fakeDb({ pins: { data: { id: "new" } } });
  mocks.createClient.mockResolvedValue(db.client);
  mocks.getOwnerAccess.mockResolvedValue(owner);
  mocks.checkRateLimit.mockResolvedValue({ admitted: true, retryAfterSeconds: 0 });
  mocks.getEmbedding.mockResolvedValue([0.1, 0.2]);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /api/pins (public)", () => {
  const get = (qs = "") => GET(new NextRequest(`http://x/api/pins${qs}`));

  it("needs no session and returns pins", async () => {
    db = fakeDb({ pins: { data: [{ id: "a" }] } });
    mocks.createClient.mockResolvedValue(db.client);
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pins: [{ id: "a" }] });
    expect(mocks.getOwnerAccess).not.toHaveBeenCalled();
  });

  it("429s with Retry-After when rate limited, before touching the table", async () => {
    mocks.checkRateLimit.mockResolvedValue({ admitted: false, retryAfterSeconds: 60 });
    const res = await get();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(db.chains.pins).toBeUndefined();
  });

  it("400s on an unknown kind filter", async () => {
    expect((await get("?kind=bogus")).status).toBe(400);
  });

  it("applies a valid kind filter", async () => {
    await get("?kind=wishlist");
    expect(db.chains.pins.called("eq")[0][1]).toEqual(["kind", "wishlist"]);
  });

  it("500s with the database error message", async () => {
    db = fakeDb({ pins: { error: { message: "boom" } } });
    mocks.createClient.mockResolvedValue(db.client);
    const res = await get();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "boom" });
  });
});

describe("POST /api/pins (owner-only)", () => {
  it("rejects non-owners with the auth status BEFORE parsing or embedding", async () => {
    mocks.getOwnerAccess.mockResolvedValue(notSignedIn);
    const res = await post(validPin);
    expect(res.status).toBe(401);
    expect(mocks.getEmbedding).not.toHaveBeenCalled();
    expect(db.chains.pins).toBeUndefined();
  });

  it.each([
    ["blank title", { ...validPin, title: "  " }],
    ["bad kind", { ...validPin, kind: "other" }],
    ["string lat", { ...validPin, lat: "1" }],
    ["lat out of range", { ...validPin, lat: 91 }],
    ["lng out of range", { ...validPin, lng: -181 }],
    ["provider without id", { ...validPin, place_provider: "google" }],
    ["id without provider", { ...validPin, external_place_id: "abc" }],
    ["unsupported provider", { ...validPin, place_provider: "osm", external_place_id: "1" }],
    ["rating 0", { ...validPin, user_rating: 0 }],
    ["rating 6", { ...validPin, user_rating: 6 }],
    ["fractional rating", { ...validPin, user_rating: 3.5 }],
    ["price tier 5", { ...validPin, price_tier: 5 }],
    ["non-array tags", { ...validPin, tags: "a" }],
    ["non-string tag", { ...validPin, tags: [1] }],
  ])("400s on %s and never writes", async (_n, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(db.chains.pins).toBeUndefined();
  });

  it("creates the pin with trimmed fields, owner id, and an embedding (201)", async () => {
    const res = await post({ ...validPin, note: " nice ", user_rating: 5, price_tier: 2 });
    expect(res.status).toBe(201);
    expect(db.chains.pins.called("insert")[0][1][0]).toMatchObject({
      title: "Cafe",
      note: "nice",
      embedding: [0.1, 0.2],
      created_by: "owner-1",
      user_rating: 5,
      price_tier: 2,
      external_place_id: null,
    });
  });

  it("embeds the combined title/note/tags text as a document", async () => {
    await post({ ...validPin, note: "n", tags: ["a"] });
    expect(mocks.getEmbedding).toHaveBeenCalledWith(db.client, "Cafe\nn\nTags: a", "document");
  });

  it("dedupes, trims, caps (10 tags, 40 chars) the tags", async () => {
    const tags = [" a ", "a", "", ...Array.from({ length: 15 }, (_, i) => `t${i}`), "x".repeat(60)];
    await post({ ...validPin, tags });
    const saved = db.chains.pins.called("insert")[0][1][0] as { tags: string[] };
    expect(saved.tags).toHaveLength(10);
    expect(saved.tags[0]).toBe("a");
    expect(new Set(saved.tags).size).toBe(10);
    const long = await post({ ...validPin, tags: ["x".repeat(60)] });
    expect(long.status).toBe(201);
    expect((db.chains.pins.called("insert")[0][1][0] as { tags: string[] }).tags[0]).toHaveLength(40);
  });

  it("still saves the pin (null embedding) if the embeddings provider is down", async () => {
    mocks.getEmbedding.mockRejectedValue(new Error("voyage down"));
    const res = await post(validPin);
    expect(res.status).toBe(201);
    expect(db.chains.pins.called("insert")[0][1][0]).toMatchObject({ embedding: null });
  });

  it("500s with the database error on insert failure", async () => {
    db = fakeDb({ pins: { error: { message: "rls" } } });
    mocks.createClient.mockResolvedValue(db.client);
    const res = await post(validPin);
    expect(res.status).toBe(500);
  });
});
