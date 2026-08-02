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
  text: string,
  inputType: EmbeddingInputType,
): Promise<number[]> {
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
      input: text,
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
  return result.data[0].embedding;
}

// Combines a pin's title and note into one string to embed. Kept in one
// place so the API route and the backfill script can't drift apart on
// exactly what text gets embedded.
export function pinTextForEmbedding(title: string, note: string | null) {
  return note ? `${title}\n${note}` : title;
}
