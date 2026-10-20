import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getEmbeddings, pinTextForEmbedding } from "@/lib/embeddings";

describe("pinTextForEmbedding", () => {
  it("joins title, note, and tags, skipping empty parts", () => {
    expect(pinTextForEmbedding("Cafe", "great espresso", ["coffee", "quiet"])).toBe(
      "Cafe\ngreat espresso\nTags: coffee, quiet",
    );
    expect(pinTextForEmbedding("Cafe", null)).toBe("Cafe");
    expect(pinTextForEmbedding("Cafe", "", [])).toBe("Cafe");
  });
});

// In-memory api_cache so getEmbeddings exercises the real cache code paths.
function memoryCache() {
  const store = new Map<string, { value: unknown; expires_at: string }>();
  const client = {
    from: () => {
      let key = "";
      const chain = {
        select: () => chain,
        eq: (_col: string, k: string) => ((key = k), chain),
        maybeSingle: async () => ({ data: store.get(key) ?? null, error: null }),
        upsert: async (row: { key: string; value: unknown; expires_at: string }) => {
          store.set(row.key, row);
          return { error: null };
        },
      };
      return chain;
    },
  } as unknown as SupabaseClient;
  return { client, store };
}

describe("getEmbeddings", () => {
  const fetchMock = vi.fn();
  const vec = (seed: number) => Array.from({ length: 1024 }, () => seed);

  // Voyage stub: returns a vector whose value encodes the input's position in the request.
  function voyageEchoes() {
    fetchMock.mockImplementation(async (_url: string, init: { body: string }) => {
      const { input } = JSON.parse(init.body) as { input: string[] };
      return {
        ok: true,
        // Deliberately out of order: the code must re-sort by `index`.
        json: async () => ({
          data: input
            .map((text, index) => ({ index, embedding: vec(text.length) }))
            .reverse(),
        }),
      };
    });
  }

  beforeEach(() => {
    vi.stubEnv("VOYAGE_API_KEY", "k");
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
    voyageEchoes();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fetchMock.mockReset();
  });

  it("makes no network call for an empty batch", async () => {
    expect(await getEmbeddings(memoryCache().client, [], "document")).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns embeddings in input order even if the API returns them shuffled", async () => {
    const out = await getEmbeddings(memoryCache().client, ["a", "bbb", "cc"], "document");
    expect(out.map((v) => v[0])).toEqual([1, 3, 2]);
  });

  it("only sends cache misses to Voyage and serves the rest from cache", async () => {
    const { client } = memoryCache();
    await getEmbeddings(client, ["a"], "document");
    fetchMock.mockClear();

    const out = await getEmbeddings(client, ["a", "bb"], "document");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).input).toEqual(["bb"]);
    expect(out.map((v) => v[0])).toEqual([1, 2]);
  });

  it("a fully cached batch makes zero API calls", async () => {
    const { client } = memoryCache();
    await getEmbeddings(client, ["a", "bb"], "query");
    fetchMock.mockClear();
    await getEmbeddings(client, ["a", "bb"], "query");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caches document and query embeddings separately", async () => {
    const { client } = memoryCache();
    await getEmbeddings(client, ["a"], "document");
    fetchMock.mockClear();
    await getEmbeddings(client, ["a"], "query");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a wrong-dimension response instead of caching bad data", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ index: 0, embedding: [1, 2, 3] }] }),
    });
    const { client, store } = memoryCache();
    await expect(getEmbeddings(client, ["a"], "document")).rejects.toThrow(/unexpected number or size/);
    expect(store.size).toBe(0);
  });

  it("surfaces Voyage HTTP errors", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => "oops" });
    await expect(getEmbeddings(memoryCache().client, ["a"], "document")).rejects.toThrow("500");
  });
});
