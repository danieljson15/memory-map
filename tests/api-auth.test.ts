import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getOwnerAccess } from "@/lib/api-auth";

function client(opts: {
  user?: { id: string } | null;
  userError?: unknown;
  isOwner?: boolean | null;
  ownerError?: { message: string } | null;
}) {
  return {
    auth: {
      getUser: async () => ({
        data: { user: opts.user ?? null },
        error: opts.userError ?? null,
      }),
    },
    rpc: async () => ({ data: opts.isOwner ?? null, error: opts.ownerError ?? null }),
  } as unknown as SupabaseClient;
}

describe("getOwnerAccess", () => {
  it("401 when there is no session", async () => {
    expect(await getOwnerAccess(client({ user: null }))).toMatchObject({ status: 401, user: null });
  });

  it("401 when the auth lookup errors", async () => {
    const out = await getOwnerAccess(client({ user: { id: "u" }, userError: new Error("x") }));
    expect(out.status).toBe(401);
  });

  it("403 for a signed-in non-owner", async () => {
    const out = await getOwnerAccess(client({ user: { id: "u" }, isOwner: false }));
    expect(out).toMatchObject({ status: 403, user: null });
  });

  it("500 (not 403) when the owner check itself fails, so outages aren't mistaken for denial", async () => {
    const out = await getOwnerAccess(
      client({ user: { id: "u" }, ownerError: { message: "rpc failed" } }),
    );
    expect(out.status).toBe(500);
    expect(out.error).toContain("rpc failed");
  });

  it("200 with the user for an owner", async () => {
    const out = await getOwnerAccess(client({ user: { id: "u" }, isOwner: true }));
    expect(out).toMatchObject({ status: 200, error: null, user: { id: "u" } });
  });
});
