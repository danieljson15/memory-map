import { afterEach, describe, expect, it, vi } from "vitest";
import { admitGoogleApiUsage, getMonthlyAllowance } from "@/lib/usage";
import { fakeSupabase } from "./helpers";

afterEach(() => vi.unstubAllEnvs());

describe("getMonthlyAllowance", () => {
  it("uses defaults, with the public demo budget far below the owners'", () => {
    expect(getMonthlyAllowance("public_places_request")).toBeLessThan(
      getMonthlyAllowance("places_request"),
    );
  });

  it("honors a valid env override", () => {
    vi.stubEnv("GOOGLE_PLACES_MONTHLY_REQUEST_ALLOWANCE", "42");
    expect(getMonthlyAllowance("places_request")).toBe(42);
  });

  it.each(["abc", "0", "-5", ""])("ignores an invalid override %j", (raw) => {
    vi.stubEnv("GOOGLE_PLACES_MONTHLY_REQUEST_ALLOWANCE", raw);
    expect(getMonthlyAllowance("places_request")).toBe(300);
  });
});

describe("admitGoogleApiUsage", () => {
  it("admits and increments while under the allowance", async () => {
    vi.stubEnv("GOOGLE_PLACES_MONTHLY_REQUEST_ALLOWANCE", "10");
    const { client, rpc } = fakeSupabase({
      get_google_api_usage: () => ({ data: 3, error: null }),
      increment_google_api_usage: () => ({ data: 4, error: null }),
    });
    expect(await admitGoogleApiUsage(client, "places_request")).toEqual({
      admitted: true,
      count: 4,
      allowance: 10,
    });
    expect(rpc).toHaveBeenCalledWith("increment_google_api_usage", { p_kind: "places_request" });
  });

  it("refuses at the allowance and does NOT increment (refused calls never hit Google)", async () => {
    vi.stubEnv("GOOGLE_PLACES_MONTHLY_REQUEST_ALLOWANCE", "10");
    const { client, rpc } = fakeSupabase({
      get_google_api_usage: () => ({ data: 10, error: null }),
    });
    const out = await admitGoogleApiUsage(client, "places_request");
    expect(out.admitted).toBe(false);
    expect(rpc).not.toHaveBeenCalledWith("increment_google_api_usage", expect.anything());
  });

  it.each(["maps_js_load", "public_places_request"] as const)(
    "fails CLOSED on a read error for unauthenticated surface %s",
    async (kind) => {
      const { client } = fakeSupabase({
        get_google_api_usage: () => ({ data: null, error: { message: "db" } }),
      });
      expect((await admitGoogleApiUsage(client, kind)).admitted).toBe(false);
    },
  );

  it("fails OPEN on a read error for the owner-gated places_request", async () => {
    const { client } = fakeSupabase({
      get_google_api_usage: () => ({ data: null, error: { message: "db" } }),
    });
    expect((await admitGoogleApiUsage(client, "places_request")).admitted).toBe(true);
  });

  it("still admits if the increment itself fails", async () => {
    const { client } = fakeSupabase({
      get_google_api_usage: () => ({ data: 2, error: null }),
      increment_google_api_usage: () => ({ data: null, error: { message: "db" } }),
    });
    expect(await admitGoogleApiUsage(client, "places_request")).toMatchObject({
      admitted: true,
      count: 3,
    });
  });
});
