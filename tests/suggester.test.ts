import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BudgetExceededError,
  runSuggester,
  runSuggesterWithinBudget,
  type SuggesterInput,
  type SuggesterResult,
} from "@/lib/suggester";

const input: SuggesterInput = {
  budget: 1000,
  departureAirport: "IAD",
  travelMonth: "May",
  nights: 5,
  candidates: [{ title: "Lisbon", note: null, similarity: 0.8 }],
  memories: [],
};

function result(total: number): SuggesterResult {
  return {
    destination: "Lisbon",
    costBreakdown: { flights: total, lodging: 0, food: 0, activities: 0 },
    totalCost: total,
    steps: ["step"],
  };
}

describe("runSuggesterWithinBudget", () => {
  it("returns on the first attempt when already within budget (boundary: equal)", async () => {
    const run = vi.fn().mockResolvedValue(result(1000));
    const out = await runSuggesterWithinBudget(input, run);
    expect(out.attempts).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].feedback).toBeUndefined();
  });

  it("retries with feedback naming the exact overage, then succeeds", async () => {
    const run = vi.fn().mockResolvedValueOnce(result(1250)).mockResolvedValueOnce(result(900));
    const out = await runSuggesterWithinBudget(input, run);
    expect(out.attempts).toBe(2);
    expect(out.result.totalCost).toBe(900);
    expect(run.mock.calls[1][0].feedback).toContain("250 EUR over");
  });

  it("throws BudgetExceededError after 3 total attempts, carrying the last total", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(result(1500))
      .mockResolvedValueOnce(result(1400))
      .mockResolvedValueOnce(result(1300));
    const err = await runSuggesterWithinBudget(input, run).catch((e) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(err).toMatchObject({ totalCost: 1300, budget: 1000, attempts: 3 });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("propagates upstream failures instead of swallowing them", async () => {
    const run = vi.fn().mockRejectedValue(new Error("groq down"));
    await expect(runSuggesterWithinBudget(input, run)).rejects.toThrow("groq down");
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("runSuggester (Groq response handling)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubEnv("GROQ_API_KEY", "test-key");
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  function groqReturns(args: unknown) {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify(args) } }] } }],
      }),
    });
  }

  const valid = {
    destination: "  Porto ",
    cost_breakdown: { flights: 300, lodging: 400, food: 150, activities: 50 },
    steps: [" Picking Porto. "],
  };

  it("parses the tool call, trims strings, and computes the total itself", async () => {
    groqReturns(valid);
    const out = await runSuggester(input);
    expect(out.destination).toBe("Porto");
    expect(out.steps).toEqual(["Picking Porto."]);
    expect(out.totalCost).toBe(900);
  });

  it("sends the key as a bearer token and forces the finalize tool", async () => {
    groqReturns(valid);
    await runSuggester(input);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer test-key");
    expect(JSON.parse(init.body).tool_choice.function.name).toBe("finalize_suggestion");
  });

  it("fails fast with a clear error when the API key is missing", async () => {
    vi.stubEnv("GROQ_API_KEY", "");
    await expect(runSuggester(input)).rejects.toThrow(/GROQ_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["negative cost", { ...valid, cost_breakdown: { ...valid.cost_breakdown, food: -1 } }],
    ["non-numeric cost", { ...valid, cost_breakdown: { ...valid.cost_breakdown, food: "10" } }],
    ["missing a cost field", { ...valid, cost_breakdown: { flights: 1, lodging: 1, food: 1 } }],
    ["blank destination", { ...valid, destination: "   " }],
    ["no steps", { ...valid, steps: [] }],
    ["blank step", { ...valid, steps: ["ok", " "] }],
  ])("rejects a malformed payload: %s", async (_name, payload) => {
    groqReturns(payload);
    await expect(runSuggester(input)).rejects.toThrow("invalid suggestion payload");
  });

  it("errors when the model returns no tool call", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: {} }] }) });
    await expect(runSuggester(input)).rejects.toThrow(/tool call/);
  });

  it("surfaces HTTP failures with status and body", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, text: async () => "rate limited" });
    await expect(runSuggester(input)).rejects.toThrow("429");
  });
});
