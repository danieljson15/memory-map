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
// Model choice: openai/gpt-oss-120b — llama-3.3-70b-versatile (the
// original choice here) was decommissioned by Groq on Aug 16, 2026;
// this is Groq's own recommended replacement for it. qwen/qwen3.6-27b
// was Groq's other suggested replacement and is smaller with parallel
// tool-use support, worth trying if this one's forced-tool-call
// reliability or latency disappoints — Groq's docs don't distinguish
// forced-tool_choice reliability from general tool-use support per
// model, so that's a real thing to keep an eye on, same as the original
// comment's reasoning for preferring the larger model. Groq's free-tier
// lineup shifts over time; check console.groq.com/docs/deprecations if
// this one ever 404s.

const GROQ_CHAT_COMPLETIONS_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "openai/gpt-oss-120b";

export interface SuggesterCandidate {
  title: string;
  note: string | null;
  similarity: number;
  // Set by hybrid retrieval: whether the traveler's mood keywords matched
  // this pin's text, its price tier, and its distance from the map anchor.
  keywordMatch?: boolean;
  priceTier?: number | null;
  distanceKm?: number | null;
}

export interface MemoryContext {
  title: string;
  note: string | null;
  user_rating: number | null;
  tags: string[];
}

export interface SuggesterInput {
  budget: number;
  departureAirport: string;
  travelMonth: string;
  nights: number;
  candidates: SuggesterCandidate[];
  memories: MemoryContext[];
  // Free-text preferences ("quiet coastal seafood"), passed to the model as
  // context and used upstream as the keyword leg of hybrid retrieval.
  mood?: string;
  // Set on a retry after an over-budget answer; see runSuggesterWithinBudget.
  feedback?: string;
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
          description:
            "All four figures in EUR (the traveler's budget currency), and " +
            "their SUM must not exceed the traveler's budget. Never use a " +
            "different currency, even if your reasoning about typical " +
            "prices for the destination naturally comes to mind in another one.",
          properties: {
            flights: { type: "number", description: "EUR" },
            lodging: { type: "number", description: "EUR" },
            food: { type: "number", description: "EUR" },
            activities: { type: "number", description: "EUR" },
          },
          required: ["flights", "lodging", "food", "activities"],
        },
        steps: {
          type: "array",
          items: { type: "string" },
          description:
            "3-6 reasoning steps, each ONE short sentence — a clause, not a " +
            "paragraph, no more than about 15 words. Good: 'Considering " +
            "Lisbon based on strong similarity to past trips.' Bad (too " +
            "long): a multi-clause sentence explaining several facts at " +
            "once. Write these as if thinking out loud, one idea per step, " +
            "not a full explanation of that idea.",
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
        `${i + 1}. ${c.title} (similarity to travel history: ${c.similarity.toFixed(2)}${
          c.keywordMatch ? "; matches their stated mood" : ""
        }${
          c.priceTier ? `; price level ${c.priceTier}/4` : ""
        }${
          typeof c.distanceKm === "number" ? `; ${Math.round(c.distanceKm)} km from their chosen area` : ""
        })${c.note ? ` — ${c.note}` : ""}`,
    )
    .join("\n");

  const memoryList =
    input.memories.length > 0
      ? input.memories
          .map((m) => {
            const details = [
              m.note,
              m.user_rating ? `personal rating ${m.user_rating}/5` : null,
              m.tags.length > 0 ? `tags: ${m.tags.join(", ")}` : null,
            ].filter(Boolean);
            return `- ${m.title}${details.length > 0 ? `: ${details.join("; ")}` : ""}`;
          })
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
${input.mood?.trim() ? `\nThe traveler also said what they are in the mood for: "${input.mood.trim()}". Weigh it, but it does not override the budget.\n` : ""}
The four cost_breakdown figures must add up to no more than ${input.budget} EUR.
This is a hard limit, not a target. If your first choice cannot fit, choose a
cheaper destination or trip shape — do not just shave the estimates below
what that trip realistically costs.

Keep each reasoning step to one short sentence, not a paragraph — this
is a UI list, not an essay, and a wall of text per step reads poorly.

Give your best real-world cost estimate — you don't have live pricing,
so reason from general knowledge of typical costs for that destination,
month, and traveler profile. Report every cost_breakdown figure in EUR,
converting in your head from whatever currency you'd naturally think of
local prices in — never mix currencies or leave a figure in the
destination's local currency. Be honest in your steps that these are
estimates, not live prices. Call finalize_suggestion with your answer.${
    input.feedback ? `\n\nCorrection needed: ${input.feedback}` : ""
  }`;

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

  const costValues = Object.values(toolInput.cost_breakdown ?? {});
  if (
    !toolInput.destination?.trim() ||
    costValues.length !== 4 ||
    costValues.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0) ||
    !Array.isArray(toolInput.steps) ||
    toolInput.steps.length === 0 ||
    toolInput.steps.some((step) => typeof step !== "string" || !step.trim())
  ) {
    throw new Error("Groq returned an invalid suggestion payload.");
  }

  const totalCost =
    toolInput.cost_breakdown.flights +
    toolInput.cost_breakdown.lodging +
    toolInput.cost_breakdown.food +
    toolInput.cost_breakdown.activities;

  return {
    destination: toolInput.destination.trim(),
    costBreakdown: toolInput.cost_breakdown,
    totalCost,
    steps: toolInput.steps.map((step) => step.trim()),
  };
}


// Thrown when the model's total is still over budget after every retry.
export class BudgetExceededError extends Error {
  constructor(
    public readonly totalCost: number,
    public readonly budget: number,
    public readonly attempts: number,
  ) {
    super(
      `Could not find a trip within ${budget} EUR — the closest attempt still came to ` +
        `${totalCost} EUR after ${attempts} tries. Try a larger budget or fewer nights.`,
    );
    this.name = "BudgetExceededError";
  }
}

const MAX_BUDGET_RETRIES = 2;

// The budget is enforced here, in code, not left to the model's good
// intentions: the prompt asks for a total within budget, but a model
// cannot be trusted to do its own arithmetic constraint. runSuggester
// already sums the breakdown itself, so this compares a total the model
// did not get to report. On a miss it retries with feedback naming the
// exact overage, and if it is still over after MAX_BUDGET_RETRIES it fails
// with a clear error rather than returning a misleading result.
// `run` is injectable so this can be tested without calling the API.
export async function runSuggesterWithinBudget(
  input: SuggesterInput,
  run: (input: SuggesterInput) => Promise<SuggesterResult> = runSuggester,
): Promise<{ result: SuggesterResult; attempts: number }> {
  let feedback: string | undefined;
  let last: SuggesterResult | undefined;

  for (let attempt = 1; attempt <= 1 + MAX_BUDGET_RETRIES; attempt += 1) {
    last = await run({ ...input, feedback });
    if (last.totalCost <= input.budget) {
      return { result: last, attempts: attempt };
    }
    feedback =
      `Your previous answer (${last.destination}) totaled ${last.totalCost} EUR, ` +
      `which is ${last.totalCost - input.budget} EUR over the ${input.budget} EUR budget. ` +
      `Re-plan so the four figures sum to at most ${input.budget} EUR.`;
  }

  throw new BudgetExceededError(last!.totalCost, input.budget, 1 + MAX_BUDGET_RETRIES);
}
