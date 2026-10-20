// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Pin } from "@/lib/types";
import type { PinWithPhotos, PlaceDetails } from "@/shared/api-types";

vi.mock("liquid-glass-react", () => ({
  default: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));

// In-memory stand-in for the Supabase "photos" bucket, so tests can assert on
// what is left in storage (outcome) rather than on which calls were made.
const storage = vi.hoisted(() => ({
  files: new Set<string>(),
  // Real storage-js errors are Error instances (StorageError extends Error).
  uploadError: null as Error | null,
}));

vi.mock("@/lib/supabaseClient", () => ({
  supabase: {
    storage: {
      from: () => ({
        upload: async (path: string) => {
          if (storage.uploadError) return { error: storage.uploadError };
          storage.files.add(path);
          return { error: null };
        },
        remove: async (paths: string[]) => {
          paths.forEach((p) => storage.files.delete(p));
          return { error: null };
        },
        getPublicUrl: (path: string) => ({ data: { publicUrl: `https://cdn.test/${path}` } }),
      }),
    },
  },
}));

import PinModal from "@/components/PinModal";

// --- fetch router -----------------------------------------------------------

interface Recorded {
  method: string;
  url: string;
  body: Record<string, unknown> | undefined;
}
type Handler = () => { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }>;

let requests: Recorded[];
let handlers: Record<string, Handler>;

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET";
      requests.push({ method, url, body: init?.body ? JSON.parse(init.body) : undefined });
      const handler = handlers[`${method} ${url}`];
      if (!handler) throw new Error(`unhandled request: ${method} ${url}`);
      const { status = 200, body = {} } = await handler();
      return { ok: status >= 200 && status < 300, status, json: async () => body };
    }),
  );
}

const sent = (method: string, url: string) =>
  requests.filter((r) => r.method === method && r.url === url);

// --- fixtures ---------------------------------------------------------------

const createdPin = { id: "new-pin", title: "Cafe" } as Pin;
const existingPin: PinWithPhotos = {
  id: "pin-1",
  kind: "wishlist",
  lat: 1,
  lng: 2,
  title: "Old title",
  note: "old note",
  user_rating: 4,
  price_tier: 2,
  tags: ["coffee", "quiet"],
  photos: [],
} as unknown as PinWithPhotos;
const withPhoto: PinWithPhotos = {
  ...existingPin,
  photos: [{ id: "photo-1", storage_path: "owner/old.jpg" }],
} as unknown as PinWithPhotos;
const place: PlaceDetails = {
  place_id: "ChIJabc",
  name: "Blue Bottle",
  address: "1 Main St",
  lat: 1,
  lng: 2,
  primary_type: "cafe",
  types: [],
  google_maps_uri: null,
};

const image = (name = "pic.png", bytes = 10) =>
  new File([new Uint8Array(bytes)], name, { type: "image/png" });

function renderModal(props: Partial<React.ComponentProps<typeof PinModal>> = {}) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(
    <PinModal lat={10} lng={20} userId="owner" onClose={onClose} onSaved={onSaved} {...props} />,
  );
  return { onClose, onSaved, user: userEvent.setup({ applyAccept: false }) };
}

const photoInput = () => screen.getByLabelText(/Photo/) as HTMLInputElement;
const saveButton = (name = "Save pin") => screen.getByRole("button", { name });

beforeEach(() => {
  requests = [];
  storage.files.clear();
  storage.uploadError = null;
  handlers = {
    "POST /api/pins": () => ({ status: 201, body: { pin: createdPin } }),
    "POST /api/pins/new-pin/photos": () => ({ status: 201, body: {} }),
    "DELETE /api/pins/new-pin": () => ({ body: { success: true } }),
    "PATCH /api/pins/pin-1": () => ({ body: { pin: { ...existingPin, title: "Updated" } } }),
    "POST /api/pins/pin-1/photos": () => ({ status: 201, body: {} }),
    "DELETE /api/pins/pin-1/photos/photo-1": () => ({ body: { success: true } }),
  };
  installFetch();
  vi.spyOn(crypto, "randomUUID").mockReturnValue("11111111-1111-1111-1111-111111111111");
});

// ============================================================================

describe("PinModal — creating", () => {
  it("POSTs the trimmed, normalized form and reports the created pin", async () => {
    const { user, onSaved, onClose } = renderModal();
    await user.selectOptions(screen.getByLabelText("Pin type"), "wishlist");
    await user.type(screen.getByLabelText("Title"), "  Cafe  ");
    await user.type(screen.getByLabelText("Note"), "  great espresso ");
    await user.selectOptions(screen.getByLabelText(/Your rating/), "5");
    await user.selectOptions(screen.getByLabelText(/Price level/), "3");
    await user.type(screen.getByLabelText(/Tags/), " coffee, ,quiet ,");
    await user.click(saveButton());

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(sent("POST", "/api/pins")).toHaveLength(1);
    expect(sent("POST", "/api/pins")[0].body).toEqual({
      lat: 10,
      lng: 20,
      title: "Cafe",
      note: "great espresso",
      kind: "wishlist",
      user_rating: 5,
      price_tier: 3,
      tags: ["coffee", "quiet"],
    });
    expect(onSaved).toHaveBeenCalledWith(createdPin, undefined);
  });

  it("sends a null note and omits unset rating/price/place fields", async () => {
    const { user } = renderModal();
    await user.type(screen.getByLabelText("Title"), "Cafe");
    await user.click(saveButton());
    await waitFor(() => expect(sent("POST", "/api/pins")).toHaveLength(1));
    const body = sent("POST", "/api/pins")[0].body!;
    expect(body.note).toBeNull();
    expect(body).not.toHaveProperty("place_provider");
    expect(JSON.stringify(body)).not.toContain("user_rating");
    expect(body.kind).toBe("memory");
  });

  it("prefills from a Google place and sends its canonical id", async () => {
    const { user } = renderModal({ place });
    expect(screen.getByLabelText("Title")).toHaveValue("Blue Bottle");
    expect(screen.getByText("1 Main St", { exact: false })).toBeInTheDocument();
    await user.click(saveButton());
    await waitFor(() => expect(sent("POST", "/api/pins")).toHaveLength(1));
    expect(sent("POST", "/api/pins")[0].body).toMatchObject({
      title: "Blue Bottle",
      place_provider: "google",
      external_place_id: "ChIJabc",
    });
  });

  describe("validation", () => {
    it.each(["", "   "])("blocks a blank title (%j) without any network call", async (title) => {
      const { user, onClose } = renderModal();
      if (title) await user.type(screen.getByLabelText("Title"), title);
      await user.click(saveButton());
      expect(await screen.findByText("Give this pin a title.")).toBeInTheDocument();
      expect(requests).toHaveLength(0);
      expect(onClose).not.toHaveBeenCalled();
    });

    it("clears the validation error on the next attempt", async () => {
      const { user } = renderModal();
      await user.click(saveButton());
      await screen.findByText("Give this pin a title.");
      await user.type(screen.getByLabelText("Title"), "Cafe");
      await user.click(saveButton());
      await waitFor(() => expect(screen.queryByText("Give this pin a title.")).not.toBeInTheDocument());
    });

    it("rejects a photo over 10 MB before uploading anything", async () => {
      const { user } = renderModal();
      await user.type(screen.getByLabelText("Title"), "Cafe");
      await user.upload(photoInput(), image("big.png", 10 * 1024 * 1024 + 1));
      await user.click(saveButton());
      expect(await screen.findByText("Choose a photo smaller than 10 MB.")).toBeInTheDocument();
      expect(storage.files.size).toBe(0);
      expect(requests).toHaveLength(0);
    });

    it("accepts a photo of exactly 10 MB (boundary)", async () => {
      const { user, onClose } = renderModal();
      await user.type(screen.getByLabelText("Title"), "Cafe");
      await user.upload(photoInput(), image("max.png", 10 * 1024 * 1024));
      await user.click(saveButton());
      await waitFor(() => expect(onClose).toHaveBeenCalled());
    });

    it("rejects a non-image file", async () => {
      const { user } = renderModal();
      await user.type(screen.getByLabelText("Title"), "Cafe");
      await user.upload(photoInput(), new File(["x"], "notes.txt", { type: "text/plain" }));
      await user.click(saveButton());
      expect(await screen.findByText("The selected file must be an image.")).toBeInTheDocument();
      expect(requests).toHaveLength(0);
    });
  });

  describe("photo upload", () => {
    it("uploads under the user's folder, then creates the pin and attaches the same path", async () => {
      const { user, onSaved } = renderModal();
      await user.type(screen.getByLabelText("Title"), "Cafe");
      await user.upload(photoInput(), image("Trip.PNG"));
      await user.click(saveButton());

      const path = "owner/11111111-1111-1111-1111-111111111111.png";
      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      expect(storage.files).toEqual(new Set([path]));
      expect(sent("POST", "/api/pins/new-pin/photos")[0].body).toEqual({ storage_path: path });
      expect(onSaved).toHaveBeenCalledWith(createdPin, `https://cdn.test/${path}`);
    });

    it.each([["archive.tar.gz-extension-too-long"], ["noextension"], ["weird.<script>"]])(
      "falls back to .jpg for an unsafe or missing extension (%s)",
      async (name) => {
        const { user, onClose } = renderModal();
        await user.type(screen.getByLabelText("Title"), "Cafe");
        await user.upload(photoInput(), image(name));
        await user.click(saveButton());
        await waitFor(() => expect(onClose).toHaveBeenCalled());
        const [path] = [...storage.files];
        expect(path).toMatch(/^owner\/[0-9a-f-]{36}\.jpg$/);
      },
    );

    it("shows the error and creates no pin when the upload itself fails", async () => {
      storage.uploadError = new Error("Bucket quota exceeded");
      const { user, onSaved } = renderModal();
      await user.type(screen.getByLabelText("Title"), "Cafe");
      await user.upload(photoInput(), image());
      await user.click(saveButton());
      expect(await screen.findByText("Bucket quota exceeded")).toBeInTheDocument();
      expect(sent("POST", "/api/pins")).toHaveLength(0);
      expect(onSaved).not.toHaveBeenCalled();
      expect(saveButton()).toBeEnabled();
    });

    it("removes the orphaned upload if pin creation fails", async () => {
      handlers["POST /api/pins"] = () => ({ status: 400, body: { error: "title is required" } });
      const { user, onSaved, onClose } = renderModal();
      await user.type(screen.getByLabelText("Title"), "Cafe");
      await user.upload(photoInput(), image());
      await user.click(saveButton());

      expect(await screen.findByText("title is required")).toBeInTheDocument();
      expect(storage.files.size).toBe(0);
      expect(sent("DELETE", "/api/pins/new-pin")).toHaveLength(0); // nothing to roll back
      expect(onSaved).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    });

    it("rolls back BOTH the pin and the upload if attaching the photo fails", async () => {
      handlers["POST /api/pins/new-pin/photos"] = () => ({ status: 500, body: { error: "db down" } });
      const { user, onSaved, onClose } = renderModal();
      await user.type(screen.getByLabelText("Title"), "Cafe");
      await user.upload(photoInput(), image());
      await user.click(saveButton());

      expect(await screen.findByText("db down")).toBeInTheDocument();
      expect(sent("DELETE", "/api/pins/new-pin")).toHaveLength(1);
      expect(storage.files.size).toBe(0);
      expect(onSaved).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    });

    it("lets the user retry after a rolled-back failure without leaving duplicates", async () => {
      handlers["POST /api/pins/new-pin/photos"] = () => ({ status: 500, body: { error: "db down" } });
      const { user, onClose } = renderModal();
      await user.type(screen.getByLabelText("Title"), "Cafe");
      await user.upload(photoInput(), image());
      await user.click(saveButton());
      await screen.findByText("db down");

      handlers["POST /api/pins/new-pin/photos"] = () => ({ status: 201, body: {} });
      await user.click(saveButton());
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      // Two pins were created over the session, but the first was deleted.
      expect(sent("POST", "/api/pins")).toHaveLength(2);
      expect(sent("DELETE", "/api/pins/new-pin")).toHaveLength(1);
      expect(storage.files.size).toBe(1);
    });
  });

  describe("failure handling", () => {
    it("shows the server's error message and keeps the form open and editable", async () => {
      handlers["POST /api/pins"] = () => ({ status: 403, body: { error: "Only the two owner accounts can make changes." } });
      const { user, onClose } = renderModal();
      await user.type(screen.getByLabelText("Title"), "Cafe");
      await user.click(saveButton());
      expect(await screen.findByText(/Only the two owner accounts/)).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByLabelText("Title")).toHaveValue("Cafe"); // input preserved
      expect(saveButton()).toBeEnabled();
    });

    it("falls back to a generic message when the error body has none", async () => {
      handlers["POST /api/pins"] = () => ({ status: 500, body: {} });
      const { user } = renderModal();
      await user.type(screen.getByLabelText("Title"), "Cafe");
      await user.click(saveButton());
      expect(await screen.findByText("Failed to create pin")).toBeInTheDocument();
    });

    it("shows a network failure instead of crashing", async () => {
      handlers["POST /api/pins"] = () => {
        throw new Error("Failed to fetch");
      };
      const { user } = renderModal();
      await user.type(screen.getByLabelText("Title"), "Cafe");
      await user.click(saveButton());
      expect(await screen.findByText("Failed to fetch")).toBeInTheDocument();
      expect(saveButton()).toBeEnabled();
    });
  });

  describe("duplicate submission", () => {
    it("sends one request however many times Save is clicked while pending", async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      handlers["POST /api/pins"] = async () => {
        await gate;
        return { status: 201, body: { pin: createdPin } };
      };
      const { user, onSaved, onClose } = renderModal();
      await user.type(screen.getByLabelText("Title"), "Cafe");

      await user.click(saveButton());
      const pending = await screen.findByRole("button", { name: "Saving..." });
      expect(pending).toBeDisabled();
      expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
      await user.click(pending);
      await user.click(pending);
      expect(sent("POST", "/api/pins")).toHaveLength(1);

      release();
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(onSaved).toHaveBeenCalledTimes(1);
      expect(sent("POST", "/api/pins")).toHaveLength(1);
    });

    it("re-enables Save after a failure so the user can try again", async () => {
      handlers["POST /api/pins"] = () => ({ status: 500, body: { error: "boom" } });
      const { user } = renderModal();
      await user.type(screen.getByLabelText("Title"), "Cafe");
      await user.click(saveButton());
      await screen.findByText("boom");
      expect(saveButton()).toBeEnabled();
    });
  });
});

describe("PinModal — editing", () => {
  it("prefills every field from the existing pin and labels the actions accordingly", () => {
    renderModal({ pin: existingPin });
    expect(screen.getByRole("heading", { name: "Edit pin" })).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toHaveValue("Old title");
    expect(screen.getByLabelText("Note")).toHaveValue("old note");
    expect(screen.getByLabelText("Pin type")).toHaveValue("wishlist");
    expect(screen.getByLabelText(/Your rating/)).toHaveValue("4");
    expect(screen.getByLabelText(/Price level/)).toHaveValue("2");
    expect(screen.getByLabelText(/Tags/)).toHaveValue("coffee, quiet");
    expect(saveButton("Save changes")).toBeInTheDocument();
  });

  it("PATCHes the changed fields to the pin's own URL and never POSTs a new pin", async () => {
    const { user, onSaved, onClose } = renderModal({ pin: existingPin });
    await user.clear(screen.getByLabelText("Title"));
    await user.type(screen.getByLabelText("Title"), " New title ");
    await user.selectOptions(screen.getByLabelText("Pin type"), "memory");
    await user.clear(screen.getByLabelText(/Tags/));
    await user.type(screen.getByLabelText(/Tags/), "a, b");
    await user.click(saveButton("Save changes"));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(sent("POST", "/api/pins")).toHaveLength(0);
    expect(sent("PATCH", "/api/pins/pin-1")).toHaveLength(1);
    expect(sent("PATCH", "/api/pins/pin-1")[0].body).toEqual({
      kind: "memory",
      title: "New title",
      note: "old note",
      user_rating: 4,
      price_tier: 2,
      tags: ["a", "b"],
    });
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ title: "Updated" }), undefined);
  });

  it("sends explicit nulls when optional fields are cleared (so the server clears them)", async () => {
    const { user } = renderModal({ pin: existingPin });
    await user.clear(screen.getByLabelText("Note"));
    await user.selectOptions(screen.getByLabelText(/Your rating/), "");
    await user.selectOptions(screen.getByLabelText(/Price level/), "");
    await user.click(saveButton("Save changes"));
    await waitFor(() => expect(sent("PATCH", "/api/pins/pin-1")).toHaveLength(1));
    expect(sent("PATCH", "/api/pins/pin-1")[0].body).toMatchObject({
      note: null,
      user_rating: null,
      price_tier: null,
    });
  });

  it("shows the server error and stays open when the PATCH fails, touching no photos", async () => {
    handlers["PATCH /api/pins/pin-1"] = () => ({ status: 403, body: { error: "Only the two owner accounts can make changes." } });
    const { user, onSaved, onClose } = renderModal({ pin: withPhoto });
    await user.click(screen.getByRole("button", { name: "Remove photo" }));
    await user.click(saveButton("Save changes"));
    expect(await screen.findByText(/Only the two owner accounts/)).toBeInTheDocument();
    expect(requests.filter((r) => r.url.includes("/photos"))).toHaveLength(0);
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("validates the title on edit too", async () => {
    const { user } = renderModal({ pin: existingPin });
    await user.clear(screen.getByLabelText("Title"));
    await user.click(saveButton("Save changes"));
    expect(await screen.findByText("Give this pin a title.")).toBeInTheDocument();
    expect(requests).toHaveLength(0);
  });

  it("doesn't allow double-submitting an edit", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    handlers["PATCH /api/pins/pin-1"] = async () => {
      await gate;
      return { body: { pin: existingPin } };
    };
    const { user, onClose } = renderModal({ pin: existingPin });
    await user.click(saveButton("Save changes"));
    const pending = await screen.findByRole("button", { name: "Saving..." });
    await user.click(pending);
    release();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(sent("PATCH", "/api/pins/pin-1")).toHaveLength(1);
  });

  describe("photos", () => {
    it("shows the current photo, and hides it once marked for removal", async () => {
      const { user } = renderModal({ pin: withPhoto });
      expect(document.querySelector("img")).toHaveAttribute("src", "https://cdn.test/owner/old.jpg");
      await user.click(screen.getByRole("button", { name: "Remove photo" }));
      expect(document.querySelector("img")).toBeNull();
    });

    it("removes the photo via DELETE and reports photoUrl = null", async () => {
      const { user, onSaved } = renderModal({ pin: withPhoto });
      await user.click(screen.getByRole("button", { name: "Remove photo" }));
      await user.click(saveButton("Save changes"));
      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      expect(sent("DELETE", "/api/pins/pin-1/photos/photo-1")).toHaveLength(1);
      expect(onSaved.mock.calls[0][1]).toBeNull();
    });

    it("surfaces a failed photo removal and does not report success", async () => {
      handlers["DELETE /api/pins/pin-1/photos/photo-1"] = () => ({ status: 500, body: { error: "cannot delete" } });
      const { user, onSaved, onClose } = renderModal({ pin: withPhoto });
      await user.click(screen.getByRole("button", { name: "Remove photo" }));
      await user.click(saveButton("Save changes"));
      expect(await screen.findByText("cannot delete")).toBeInTheDocument();
      expect(onSaved).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    });

    it("leaves the photo alone when nothing about it changed", async () => {
      const { user, onSaved } = renderModal({ pin: withPhoto });
      await user.click(saveButton("Save changes"));
      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      expect(requests.filter((r) => r.url.includes("/photos"))).toHaveLength(0);
      expect(onSaved.mock.calls[0][1]).toBeUndefined();
    });

    it("replaces the photo: uploads and registers the new one BEFORE deleting the old", async () => {
      const { user, onSaved } = renderModal({ pin: withPhoto });
      await user.upload(photoInput(), image("new.png"));
      await user.click(saveButton("Save changes"));

      const newPath = "owner/11111111-1111-1111-1111-111111111111.png";
      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      expect(onSaved.mock.calls[0][1]).toBe(`https://cdn.test/${newPath}`);
      expect(storage.files.has(newPath)).toBe(true);
      const order = requests.map((r) => `${r.method} ${r.url}`);
      expect(order).toEqual([
        "PATCH /api/pins/pin-1",
        "POST /api/pins/pin-1/photos",
        "DELETE /api/pins/pin-1/photos/photo-1",
      ]);
    });

    it("keeps the OLD photo and removes the new upload if registering the replacement fails", async () => {
      handlers["POST /api/pins/pin-1/photos"] = () => ({ status: 500, body: { error: "attach failed" } });
      const { user, onSaved } = renderModal({ pin: withPhoto });
      await user.upload(photoInput(), image("new.png"));
      await user.click(saveButton("Save changes"));

      expect(await screen.findByText("attach failed")).toBeInTheDocument();
      expect(sent("DELETE", "/api/pins/pin-1/photos/photo-1")).toHaveLength(0); // never zero photos
      expect(storage.files.size).toBe(0); // no orphan
      expect(onSaved).not.toHaveBeenCalled();
    });

    it("selecting a new file cancels a pending removal (replace wins over remove)", async () => {
      const { user, onSaved } = renderModal({ pin: withPhoto });
      await user.click(screen.getByRole("button", { name: "Remove photo" }));
      await user.upload(photoInput(), image("new.png"));
      await user.click(saveButton("Save changes"));
      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      expect(sent("POST", "/api/pins/pin-1/photos")).toHaveLength(1);
      expect(typeof onSaved.mock.calls[0][1]).toBe("string");
    });
  });
});

describe("PinModal — dismissing", () => {
  it("closes via Cancel and via a backdrop click, but not from clicks inside the card", async () => {
    const { user, onClose } = renderModal();
    await user.click(screen.getByRole("heading", { name: "New pin" }));
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(document.querySelector(".modal-backdrop")!);
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(0);
  });
});
