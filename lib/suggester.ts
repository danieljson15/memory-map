// Calls Groq (free tier, no credit card required — hosts Llama, Gemma,
// and others via an OpenAI-compatible API) to pick a destination from
// ranked wishlist candidates, estimate a cost breakdown, and narrate its
// reasoning as discrete steps.
//
// Deliberate v1 simplifications, not hidden:
// - Costs are the model's own estimate, not a real flight/lodging API
//   call. Every persisted step is tagged kind: "text", never
//   "tool_call" — nothing here claims a real tool ran, since none did.
// - Returns a complete result in one call rather than streaming
//   token-by-token. The "steps" array is what a future streaming
//   version would emit live; for now the frontend can animate them in
//   sequence with a short delay for the same effect.
//
// Model choice: llama-3.3-70b-versatile — the larger free-tier model
// follows a forced tool call more reliably than the smaller 8b variant,
// which matters here since the whole response depends on it. Groq's
// free-tier model lineup shifts over time; check console.groq.com if
// this model ever 404s and swap in whatever's current (gemma2-9b-it is
// a lighter free alternative if you want to try it).

const GROQ_CHAT_COMPLETIONS_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

export interface SuggesterCandidate {
  title: string;
  note: string | null;
  similarity: number;
}

export interface MemoryContext {
  title: string;
  note: string | null;
}

export interface SuggesterInput {
  budget: number;
  departureAirport: string;
  travelMonth: string;
  nights: number;
  candidates: SuggesterCandidate[];
  memories: MemoryContext[];
}

export interface SuggesterResult {
  destination: string;
  costBreakdown: {
    flights: number;
    lodging: number;
    food: number;
    activities: number;
  };
  totalCost: number;
  steps: string[];
}

const FINALIZE_TOOL = {
  type: "function" as const,
  function: {
    name: "finalize_suggestion",
    description:
      "Report the chosen destination, an estimated cost breakdown, and the reasoning steps that led there.",
    parameters: {
      type: "object",
      properties: {
        destination: {
          type: "string",
          description:
            "The chosen destination. This can be one of the wishlist candidates given, " +
            "or a genuinely new destination you're proposing instead, if you believe it " +
            "fits their demonstrated taste and budget better than anything already on " +
            "their wishlist. Say clearly in your steps which case this is.",
        },
        cost_breakdown: {
          type: "object",
          properties: {
            flights: { type: "number" },
            lodging: { type: "number" },
            food: { type: "number" },
            activities: { type: "number" },
          },
          required: ["flights", "lodging", "food", "activities"],
        },
        steps: {
          type: "array",
          items: { type: "string" },
          description:
            "3-6 short narrative reasoning steps, e.g. 'Considering Lisbon based on strong similarity to past trips...', " +
            "'Estimated flights from CPH run high for this budget...', 'Porto offers similar appeal at lower estimated cost...', " +
            "'Finalizing Porto — estimated total fits within budget.' Write these as if thinking out loud, one idea per step.",
        },
      },
      required: ["destination", "cost_breakdown", "steps"],
    },
  },
};

export async function runSuggester(
  input: SuggesterInput,
): Promise<SuggesterResult> {
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    throw new Error(
      "GROQ_API_KEY is not set. Add it to .env.local (server-side only, " +
        "no NEXT_PUBLIC_ prefix — this key should never reach the browser).",
    );
  }

  const candidateList = input.candidates
    .map(
      (c, i) =>
        `${i + 1}. ${c.title} (similarity to travel history: ${c.similarity.toFixed(2)})${
          c.note ? ` — ${c.note}` : ""
        }`,
    )
    .join("\n");

  const memoryList =
    input.memories.length > 0
      ? input.memories
          .map((m) => `- ${m.title}${m.note ? `: ${m.note}` : ""}`)
          .join("\n")
      : "(no memory pins yet)";

  const prompt = `A traveler wants a trip suggestion.

Budget: ${input.budget} EUR total
Departure airport: ${input.departureAirport}
Month: ${input.travelMonth}
Nights: ${input.nights}

Places they've actually been and loved (their real travel history — use
this to understand their taste, don't just pattern-match on destination
names):
${memoryList}

Their current wishlist, ranked by embedding similarity to that travel
history (higher = closer match to their taste):
${candidateList}

Pick the single best trip for this budget and taste profile. You are not
limited to the wishlist above — if you genuinely believe a destination
they haven't pinned yet fits their taste and budget better than anything
on the list, propose that instead, and say so explicitly in your steps.
Otherwise, pick the best-fitting wishlist candidate.

Give your best real-world cost estimate — you don't have live pricing,
so reason from general knowledge of typical costs for that destination,
month, and traveler profile. Be honest in your steps that these are
estimates, not live prices. Call finalize_suggestion with your answer.`;

  const response = await fetch(GROQ_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      max_tokens: 1024,
      tools: [FINALIZE_TOOL],
      tool_choice: {
        type: "function",
        function: { name: "finalize_suggestion" },
      },
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Groq API request failed (${response.status}): ${errorBody}`,
    );
  }

  const result = await response.json();
  const toolCall = result.choices?.[0]?.message?.tool_calls?.[0];

  if (!toolCall) {
    throw new Error(
      "Groq did not return a finalize_suggestion tool call. The free-tier " +
        "model may not have followed the forced tool choice reliably — " +
        "worth retrying, or switching to a larger model if this repeats.",
    );
  }

  // Unlike Anthropic's tool_use.input (already a parsed object), OpenAI-
  // style function calling returns arguments as a JSON-encoded string.
  const toolInput = JSON.parse(toolCall.function.arguments) as {
    destination: string;
    cost_breakdown: {
      flights: number;
      lodging: number;
      food: number;
      activities: number;
    };
    steps: string[];
  };

  const totalCost =
    toolInput.cost_breakdown.flights +
    toolInput.cost_breakdown.lodging +
    toolInput.cost_breakdown.food +
    toolInput.cost_breakdown.activities;

  return {
    destination: toolInput.destination,
    costBreakdown: toolInput.cost_breakdown,
    totalCost,
    steps: toolInput.steps,
  };
}

