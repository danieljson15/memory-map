import { vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { GoogleNearbyPlace } from "@/lib/google-places";

type RpcResult = { data: unknown; error: { message: string } | null };

// Minimal stand-in for the slice of SupabaseClient these modules use.
// `rpc` handlers are keyed by function name so each test states exactly
// what the database "returned".
export function fakeSupabase(handlers: Record<string, () => RpcResult> = {}) {
  const rpc = vi.fn(async (name: string) => {
    const handler = handlers[name];
    if (!handler) throw new Error(`unexpected rpc: ${name}`);
    return handler();
  });
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

export function place(overrides: Partial<GoogleNearbyPlace> = {}): GoogleNearbyPlace {
  return {
    place_id: "p1",
    name: "Cafe",
    address: "1 Main St",
    lat: 0,
    lng: 0,
    primary_type: "cafe",
    types: [],
    google_maps_uri: null,
    rating: 4.0,
    rating_count: 100,
    price_level: null,
    ...overrides,
  };
}

type QueryResult = { data?: unknown; error?: { message: string } | null };

// Chainable, awaitable stand-in for a Supabase query builder. Every
// builder method returns the same chain and records its call, and
// awaiting it (or calling .single()/.maybeSingle()) yields `result`.
export function queryChain(result: QueryResult = {}) {
  const calls: Array<[string, unknown[]]> = [];
  const settled = { data: result.data ?? null, error: result.error ?? null };
  const chain: Record<string, unknown> = {
    then: (resolve: (v: typeof settled) => unknown) => resolve(settled),
  };
  for (const method of [
    "select", "insert", "update", "delete", "upsert",
    "eq", "not", "or", "order", "single", "maybeSingle",
  ]) {
    chain[method] = (...args: unknown[]) => {
      calls.push([method, args]);
      return method === "single" || method === "maybeSingle"
        ? Promise.resolve(settled)
        : chain;
    };
  }
  return { chain, calls, called: (m: string) => calls.filter(([n]) => n === m) };
}

// Supabase client whose tables return the configured results.
export function fakeDb(
  tables: Record<string, QueryResult> = {},
  rpcs: Record<string, QueryResult> = {},
  storageRemove: QueryResult = {},
) {
  const chains: Record<string, ReturnType<typeof queryChain>> = {};
  const remove = vi.fn(async () => ({ error: storageRemove.error ?? null }));
  const client = {
    from: (table: string) => {
      chains[table] = queryChain(tables[table]);
      return chains[table].chain;
    },
    rpc: vi.fn(async (name: string) => ({
      data: rpcs[name]?.data ?? null,
      error: rpcs[name]?.error ?? null,
    })),
    storage: { from: () => ({ remove }) },
  };
  return { client, chains, remove };
}
