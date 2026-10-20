import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cacheKey, getCached, setCached } from "@/lib/cache";

describe("cacheKey", () => {
  it("is deterministic and independent of property order", () => {
    expect(cacheKey("n", { a: 1, b: 2 })).toBe(cacheKey("n", { b: 2, a: 1 }));
  });

  it("differs by namespace and by value", () => {
    expect(cacheKey("a", { x: 1 })).not.toBe(cacheKey("b", { x: 1 }));
    expect(cacheKey("a", { x: 1 })).not.toBe(cacheKey("a", { x: 2 }));
  });

  // Regression: JSON.stringify's array "replacer" is an allow-list applied at
  // EVERY nesting level, so passing only the top-level keys silently dropped
  // every nested property. Different nested params then hashed identically
  // and a request could be served another request's cached result.
  describe("nested params (regression)", () => {
    it("distinguishes different nested objects", () => {
      expect(cacheKey("n", { loc: { lat: 1, lng: 2 } })).not.toBe(
        cacheKey("n", { loc: { lat: 9, lng: 9 } }),
      );
    });

    it("distinguishes different objects inside arrays", () => {
      expect(cacheKey("n", { places: [{ id: "a" }] })).not.toBe(
        cacheKey("n", { places: [{ id: "b" }] }),
      );
    });

    it("is order-independent at every depth", () => {
      expect(cacheKey("n", { a: 1, loc: { lat: 1, lng: 2 } })).toBe(
        cacheKey("n", { loc: { lng: 2, lat: 1 }, a: 1 }),
      );
    });

    it("keeps array order significant", () => {
      expect(cacheKey("n", { ids: [1, 2] })).not.toBe(cacheKey("n", { ids: [2, 1] }));
    });
  });

  it("leaves keys for flat params unchanged, so existing cache entries stay valid", () => {
    // sha256 of the pre-fix serialization of this exact input.
    expect(cacheKey("embedding", { inputType: "document", text: "hi" })).toBe(
      "embedding:ecbcb4e78fb58845479aea4c8555b4db0d4e8b5d77ec0ce46b59880d7ad5d859",
    );
  });

  it("is prefixed with its namespace and a sha256 hex digest", () => {
    expect(cacheKey("embedding", { x: 1 })).toMatch(/^embedding:[0-9a-f]{64}$/);
  });
});

// Chainable stub for supabase.from("api_cache").select().eq().maybeSingle()
// and .upsert(), returning whatever the test configures.
function fakeTable(opts: { row?: unknown; error?: unknown; upsertError?: unknown } = {}) {
  const upsert = vi.fn(async () => ({ error: opts.upsertError ?? null }));
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: opts.row ?? null, error: opts.error ?? null }),
    upsert,
  };
  return { client: { from: () => chain } as unknown as SupabaseClient, upsert };
}

describe("getCached / setCached", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns the value on a fresh hit", async () => {
    const { client } = fakeTable({ row: { value: [1, 2], expires_at: "2026-01-02T00:00:00Z" } });
    expect(await getCached(client, "k")).toEqual([1, 2]);
  });

  it("treats an expired row as a miss, including exactly at expiry", async () => {
    const { client } = fakeTable({ row: { value: 1, expires_at: "2026-01-01T00:00:00Z" } });
    expect(await getCached(client, "k")).toBeNull();
  });

  it("treats a missing row or a DB error as a miss rather than throwing", async () => {
    expect(await getCached(fakeTable().client, "k")).toBeNull();
    expect(await getCached(fakeTable({ error: { message: "boom" } }).client, "k")).toBeNull();
  });

  it("writes with an expiry of now + ttl", async () => {
    const { client, upsert } = fakeTable();
    await setCached(client, "k", { a: 1 }, 60_000);
    expect(upsert).toHaveBeenCalledWith({
      key: "k",
      value: { a: 1 },
      expires_at: "2026-01-01T00:01:00.000Z",
    });
  });

  it("does not throw when the cache write fails", async () => {
    const { client } = fakeTable({ upsertError: { message: "disk full" } });
    await expect(setCached(client, "k", 1, 1000)).resolves.toBeUndefined();
  });
});
