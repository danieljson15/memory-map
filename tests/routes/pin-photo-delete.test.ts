import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { fakeDb } from "../helpers";

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), getOwnerAccess: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: mocks.createClient }));
vi.mock("@/lib/api-auth", () => ({ getOwnerAccess: mocks.getOwnerAccess }));

import { DELETE } from "@/app/api/pins/[id]/photos/[photoId]/route";

const call = () =>
  DELETE(new NextRequest("http://x", { method: "DELETE" }), {
    params: Promise.resolve({ id: "pin-1", photoId: "photo-1" }),
  });

// pin_photos is queried twice: lookup, then delete.
function setup(opts: { photo?: unknown; deleteError?: string; storageError?: string }) {
  const db = fakeDb({}, {}, opts.storageError ? { error: { message: opts.storageError } } : {});
  let n = 0;
  db.client.from = ((t: string) => {
    const first = n++ === 0;
    return fakeDb({
      [t]: first
        ? { data: opts.photo ?? null, error: opts.photo ? null : { message: "none" } }
        : { error: opts.deleteError ? { message: opts.deleteError } : null },
    }).client.from(t);
  }) as typeof db.client.from;
  mocks.createClient.mockResolvedValue(db.client);
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getOwnerAccess.mockResolvedValue({ user: { id: "o" }, error: null, status: 200 });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("DELETE /api/pins/[id]/photos/[photoId]", () => {
  it("403s for non-owners without touching the database", async () => {
    const db = setup({ photo: { storage_path: "p.jpg" } });
    mocks.getOwnerAccess.mockResolvedValue({ user: null, error: "no", status: 403 });
    expect((await call()).status).toBe(403);
    expect(db.remove).not.toHaveBeenCalled();
  });

  it("404s when the photo doesn't exist or belongs to another pin", async () => {
    setup({});
    expect((await call()).status).toBe(404);
  });

  it("deletes the row and then the storage object", async () => {
    const db = setup({ photo: { storage_path: "p.jpg" } });
    const res = await call();
    expect(await res.json()).toEqual({ success: true });
    expect(db.remove).toHaveBeenCalledWith(["p.jpg"]);
  });

  it("500s and leaves storage alone if the row delete fails", async () => {
    const db = setup({ photo: { storage_path: "p.jpg" }, deleteError: "rls" });
    expect((await call()).status).toBe(500);
    expect(db.remove).not.toHaveBeenCalled();
  });

  it("still succeeds if only the storage cleanup fails (orphan file is harmless)", async () => {
    setup({ photo: { storage_path: "p.jpg" }, storageError: "gone" });
    expect((await call()).status).toBe(200);
  });
});
