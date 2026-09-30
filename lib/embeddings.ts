// Thin wrapper around Voyage AI's embeddings endpoint.
// Docs: https://docs.voyageai.com/docs/embeddings
//
// input_type matters and shouldn't be omitted for retrieval use cases:
// - "document" when embedding a pin being stored (this file's main use)
// - "query" when embedding the suggester's taste vector at search time
// Voyage prepends different internal prompts for each side, which is
// what makes asymmetric retrieval (cheap model for queries, bigger model
// for documents) actually work well. Getting this backwards doesn't
// error, it just quietly hurts ranking quality.
//
// Every call goes through the cache in lib/cache.ts, keyed per-text (not
// per-batch) so the same title/note text hitting two different routes —
// or the same candidate showing up in two different nearby-search
// results — still counts as a cache hit. The same text always maps to
// the same embedding for a fixed model, so a repeat call is pure waste
// without this.

import type { SupabaseClient } from "@supabase/supabase-js";
import { cacheKey, getCached, setCached, CACHE_TTL_MS } from "./cache";

const VOYAGE_EMBEDDINGS_URL = "https://ai.mongodb.com/v1/embeddings";
const EMBEDDING_MODEL = "voyage-4-lite";
const EMBEDDING_DIMENSION = 1024; // must match the `vector(1024)` column in schema.sql

interface VoyageEmbeddingResponse {
  data: { embedding: number[]; index: number }[];
  model: string;
  usage: { total_tokens: number };
}

export type EmbeddingInputType = "document" | "query";

export async function getEmbedding(
  supabase: SupabaseClient,
  text: string,
  inputType: EmbeddingInputType,
): Promise<number[]> {
  const embeddings = await getEmbeddings(supabase, [text], inputType);
  return embeddings[0];
}

function embeddingCacheKey(text: string, inputType: EmbeddingInputType) {
  return cacheKey("embedding", {
    text,
    inputType,
    model: EMBEDDING_MODEL,
    dimension: EMBEDDING_DIMENSION,
  });
}

async function callVoyage(
  texts: string[],
  inputType: EmbeddingInputType,
): Promise<number[][]> {
  const apiKey = process.env.VOYAGE_API_KEY;

  if (!apiKey) {
    throw new Error(
      "VOYAGE_API_KEY is not set. Add it to .env.local (server-side only, " +
        "no NEXT_PUBLIC_ prefix — this key should never reach the browser).",
    );
  }

  const response = await fetch(VOYAGE_EMBEDDINGS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      input: texts,
      model: EMBEDDING_MODEL,
      input_type: inputType,
      output_dimension: EMBEDDING_DIMENSION,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Voyage embeddings request failed (${response.status}): ${errorBody}`,
    );
  }

  const result = (await response.json()) as VoyageEmbeddingResponse;
  const embeddings = result.data
    .sort((a, b) => a.index - b.index)
    .map((item) => item.embedding);
  if (
    embeddings.length !== texts.length ||
    embeddings.some((embedding) => embedding.length !== EMBEDDING_DIMENSION)
  ) {
    throw new Error("Voyage returned an unexpected number or size of embeddings.");
  }
  return embeddings;
}

// Voyage accepts an array of inputs in one request. Nearby recommendations
// use this batch form so a result set costs one network round trip rather
// than one request per candidate — but the cache check/write below is
// still per-text, so a batch with some cached and some new texts only
// pays Voyage for the new ones.
export async function getEmbeddings(
  supabase: SupabaseClient,
  texts: string[],
  inputType: EmbeddingInputType,
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const keys = texts.map((text) => embeddingCacheKey(text, inputType));
  const cached = await Promise.all(
    keys.map((key) => getCached<number[]>(supabase, key)),
  );

  const missIndices: number[] = [];
  cached.forEach((value, i) => {
    if (value === null) missIndices.push(i);
  });

  const results: (number[] | null)[] = cached.slice();
  if (missIndices.length > 0) {
    const missTexts = missIndices.map((i) => texts[i]);
    const fresh = await callVoyage(missTexts, inputType);
    await Promise.all(
      missIndices.map((i, j) =>
        setCached(supabase, keys[i], fresh[j], CACHE_TTL_MS.EMBEDDING),
      ),
    );
    missIndices.forEach((i, j) => {
      results[i] = fresh[j];
    });
  }

  // Every index is filled by now — either it was a cache hit, or it was
  // a miss backfilled from the loop above.
  return results.map((embedding, i) => {
    if (!embedding) {
      throw new Error(`Missing embedding for text at index ${i} after fetch.`);
    }
    return embedding;
  });
}

// Combines a pin's title and note into one string to embed. Kept in one
// place so the API route and the backfill script can't drift apart on
// exactly what text gets embedded.
export function pinTextForEmbedding(
  title: string,
  note: string | null,
  tags: string[] = [],
) {
  return [title, note, tags.length > 0 ? `Tags: ${tags.join(", ")}` : null]
    .filter(Boolean)
    .join("\n");
}
