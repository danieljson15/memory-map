import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { fakeDb } from "../helpers";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  getOwnerAccess: vi.fn(),
  checkRateLimit: vi.fn(),
  run: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: mocks.createClient }));
vi.mock("@/lib/api-auth", () => ({ getOwnerAccess: mocks.getOwnerAccess }));
vi.mock("@/lib/rate-limit", async (orig) => ({
  ...(await orig<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: mocks.checkRateLimit,
}));
vi.mock("@/lib/suggester", async (orig) => ({
  ...(await orig<typeof import("@/lib/suggester")>()),
  runSuggesterWithinBudget: mocks.run,
}));

import { POST } from "@/app/api/suggest/route";
import { BudgetExceededError } from "@/lib/suggester";

const call = (body: unknown) =>
  POST(new NextRequest("http://x/api/suggest", { method: "POST", body: JSON.stringify(body) }));
const valid = { budget: 1000, departure_airport: "IAD", travel_month: "May", nights: 5 };
const owner = { user: { id: "owner-1" }, error: null, status: 200 };
const anon = { user: null, error: "Not signed in", status: 401 };
const outcome = {
  result: {
    destination: "Porto",
    costBreakdown: { flights: 1, lodging: 1, food: 1, activities: 1 },
    totalCost: 4,
    steps: ["one", "two"],
  },
  attempts: 2,
};

let db: ReturnType<typeof fakeDb>;
function setup(opts: { memories?: unknown[] | null; tables?: Record<string, object> } = {}) {
  db = fakeDb(
    {
      pins: { data: opts.memories === undefined ? [{ title: "m", note: null }] : opts.memories },
      suggestions: { data: { id: "s1" } },
      suggestion_steps: { data: [{ id: "st1" }] },
      ...opts.tables,
    },
    { rank_wishlist_hybrid: { data: [{ title: "Lisbon", note: null, similarity: 0.9 }] } },
  );
  mocks.createClient.mockResolvedValue(db.client);
}

beforeEach(() => {
  vi.clearAllMocks();
  setup();
  mocks.getOwnerAccess.mockResolvedValue(anon);
  mocks.checkRateLimit.mockResolvedValue({ admitted: true, retryAfterSeconds: 0 });
  mocks.run.mockResolvedValue(outcome);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/suggest — public path", () => {
  it("is rate limited per client and returns 429 + Retry-After", async () => {
    mocks.checkRateLimit.mockResolvedValue({ admitted: false, retryAfterSeconds: 3600 });
    const res = await call(valid);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("3600");
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("computes the result live but NEVER persists it", async () => {
    const res = await call(valid);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.suggestion).toMatchObject({ destination: "Porto", created_by: "public", status: "complete" });
    expect(body.steps.map((s: { content: { text: string } }) => s.content.text)).toEqual(["one", "two"]);
    expect(body.steps[0]).toMatchObject({ step_order: 1, suggestion_id: body.suggestion.id });
    expect(db.chains.suggestions).toBeUndefined();
    expect(db.chains.suggestion_steps).toBeUndefined();
  });

  it("reports the applied constraints, including the budget retries", async () => {
    const body = await (await call({ ...valid, budget: 1000, nights: 10, mood: " quiet " })).json();
    expect(body.applied).toEqual({
      max_price_tier: 1, // 100 EUR/night
      keyword: "quiet",
      radius_km: null,
      budget_attempts: 2,
    });
  });
});

describe("POST /api/suggest — owner path", () => {
  beforeEach(() => mocks.getOwnerAccess.mockResolvedValue(owner));

  it("skips the rate limiter and persists the suggestion and its steps", async () => {
    const res = await call(valid);
    expect(res.status).toBe(201);
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(db.chains.suggestions.called("insert")[0][1][0]).toMatchObject({
      created_by: "owner-1",
      destination: "Porto",
      total_cost: 4,
    });
    expect(db.chains.suggestion_steps.called("insert")[0][1][0]).toHaveLength(2);
  });

  it("500s if the suggestion insert fails", async () => {
    setup({ tables: { suggestions: { error: { message: "rls" } } } });
    expect((await call(valid)).status).toBe(500);
  });

  it("still returns 201 with empty steps if only the steps insert fails", async () => {
    setup({ tables: { suggestion_steps: { error: { message: "oops" } } } });
    const res = await call(valid);
    expect(res.status).toBe(201);
    expect((await res.json()).steps).toEqual([]);
  });
});

describe("POST /api/suggest — validation", () => {
  it.each([
    ["missing budget", { ...valid, budget: undefined }],
    ["zero budget", { ...valid, budget: 0 }],
    ["string budget", { ...valid, budget: "100" }],
    ["blank airport", { ...valid, departure_airport: " " }],
    ["overlong month", { ...valid, travel_month: "x".repeat(81) }],
    ["fractional nights", { ...valid, nights: 2.5 }],
    ["0 nights", { ...valid, nights: 0 }],
    ["61 nights", { ...valid, nights: 61 }],
    ["overlong mood", { ...valid, mood: "x".repeat(201) }],
    ["lat out of range", { ...valid, center: { lat: 100, lng: 0 } }],
    ["non-numeric center", { ...valid, center: { lat: "a", lng: 0 } }],
    ["radius too small", { ...valid, radius_km: 0 }],
    ["radius too large", { ...valid, radius_km: 20_001 }],
  ])("400s on %s before any retrieval or LLM call", async (_n, body) => {
    const res = await call(body);
    expect(res.status).toBe(400);
    expect(db.client.rpc).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("only applies the location filter when center AND radius are both given", async () => {
    await call({ ...valid, center: { lat: 1, lng: 2 } });
    expect(db.client.rpc).toHaveBeenLastCalledWith(
      "rank_wishlist_hybrid",
      expect.objectContaining({ center_lat: null, radius_km: null }),
    );
    await call({ ...valid, center: { lat: 1, lng: 2 }, radius_km: 50 });
    expect(db.client.rpc).toHaveBeenLastCalledWith(
      "rank_wishlist_hybrid",
      expect.objectContaining({ center_lat: 1, center_lng: 2, radius_km: 50 }),
    );
  });
});

describe("POST /api/suggest — failure mapping", () => {
  it("422 when there are no memory pins to reason from", async () => {
    setup({ memories: [] });
    const res = await call(valid);
    expect(res.status).toBe(422);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("500 when the retrieval RPC fails", async () => {
    db = fakeDb({ pins: { data: [{}] } }, { rank_wishlist_hybrid: { error: { message: "fn" } } });
    mocks.createClient.mockResolvedValue(db.client);
    expect((await call(valid)).status).toBe(500);
  });

  it("422 (not 502) when no answer fits the budget", async () => {
    mocks.run.mockRejectedValue(new BudgetExceededError(1300, 1000, 3));
    const res = await call(valid);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain("1000 EUR");
  });

  it("502 for any other upstream failure", async () => {
    mocks.run.mockRejectedValue(new Error("groq down"));
    const res = await call(valid);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "groq down" });
  });
});
