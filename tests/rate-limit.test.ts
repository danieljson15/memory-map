import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { RATE_LIMITS, checkRateLimit, clientIdentifier } from "@/lib/rate-limit";
import { fakeSupabase } from "./helpers";

const req = (headers: Record<string, string>) =>
  ({ headers: new Headers(headers) }) as unknown as NextRequest;

describe("clientIdentifier", () => {
  it("uses the first x-forwarded-for entry (the proxy-set client IP), trimmed", () => {
    expect(clientIdentifier(req({ "x-forwarded-for": " 1.2.3.4 , 10.0.0.1" }))).toBe("1.2.3.4");
  });

  it("falls back to 'unknown' when the header is absent or empty", () => {
    expect(clientIdentifier(req({}))).toBe("unknown");
    expect(clientIdentifier(req({ "x-forwarded-for": "" }))).toBe("unknown");
  });
});

describe("checkRateLimit", () => {
  afterEach(() => vi.restoreAllMocks());

  it("passes the per-kind window and limit, namespaced by kind and client", async () => {
    const { client, rpc } = fakeSupabase({ check_rate_limit: () => ({ data: true, error: null }) });
    await checkRateLimit(client, "PUBLIC_SUGGEST", "9.9.9.9");
    expect(rpc).toHaveBeenCalledWith("check_rate_limit", {
      p_key: "PUBLIC_SUGGEST:9.9.9.9",
      p_window_seconds: RATE_LIMITS.PUBLIC_SUGGEST.windowSeconds,
      p_limit: RATE_LIMITS.PUBLIC_SUGGEST.limit,
    });
  });

  it("admits when the database says yes, and reports retry-after when it says no", async () => {
    const yes = fakeSupabase({ check_rate_limit: () => ({ data: true, error: null }) });
    expect((await checkRateLimit(yes.client, "PUBLIC_READ", "x")).admitted).toBe(true);

    const no = fakeSupabase({ check_rate_limit: () => ({ data: false, error: null }) });
    expect(await checkRateLimit(no.client, "PUBLIC_READ", "x")).toEqual({
      admitted: false,
      retryAfterSeconds: RATE_LIMITS.PUBLIC_READ.windowSeconds,
    });
  });

  it("fails open on a database error so public reads survive an outage", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = fakeSupabase({
      check_rate_limit: () => ({ data: null, error: { message: "db down" } }),
    });
    expect(await checkRateLimit(client, "PUBLIC_NEARBY", "x")).toEqual({
      admitted: true,
      retryAfterSeconds: 0,
    });
  });

  it("keeps the expensive routes much tighter than the cheap reads", () => {
    const perMinute = (k: keyof typeof RATE_LIMITS) =>
      (RATE_LIMITS[k].limit / RATE_LIMITS[k].windowSeconds) * 60;
    expect(perMinute("PUBLIC_SUGGEST")).toBeLessThan(perMinute("PUBLIC_READ") / 100);
    expect(perMinute("PUBLIC_NEARBY")).toBeLessThan(perMinute("PUBLIC_READ") / 100);
  });
});
