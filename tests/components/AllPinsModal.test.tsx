// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PinWithPhotos } from "@/shared/api-types";

vi.mock("@/lib/supabaseClient", () => ({
  supabase: {
    storage: {
      from: () => ({
        getPublicUrl: (path: string) => ({ data: { publicUrl: `https://cdn.test/${path}` } }),
      }),
    },
  },
}));

import AllPinsModal from "@/components/AllPinsModal";

const pin = (over: Partial<PinWithPhotos>): PinWithPhotos =>
  ({
    id: "id",
    kind: "memory",
    title: "Pin",
    note: null,
    user_rating: null,
    tags: [],
    photos: [],
    ...over,
  }) as PinWithPhotos;

const pins = [
  pin({ id: "1", title: "Lisbon trip", kind: "memory", note: "pastel de nata", user_rating: 5, tags: ["food", "sea"] }),
  pin({ id: "2", title: "Kyoto", kind: "wishlist", note: "temples" }),
  pin({ id: "3", title: "Porto", kind: "memory", photos: [{ storage_path: "a/b.jpg" } as never] }),
];

const fetchMock = vi.fn();

function renderModal() {
  const onClose = vi.fn();
  const onSelectPin = vi.fn();
  render(<AllPinsModal onClose={onClose} onSelectPin={onSelectPin} />);
  return { onClose, onSelectPin, user: userEvent.setup() };
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ pins }) });
  vi.stubGlobal("fetch", fetchMock);
});

describe("AllPinsModal", () => {
  it("shows a loading state, then the pins", async () => {
    renderModal();
    expect(screen.getByText("Loading pins…")).toBeInTheDocument();
    expect(await screen.findByText("Lisbon trip")).toBeInTheDocument();
    expect(screen.queryByText("Loading pins…")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/pins");
  });

  it("renders rating and tags metadata, and resolves the public photo URL", async () => {
    renderModal();
    expect(await screen.findByText("★ 5/5 · food · sea")).toBeInTheDocument();
    expect(screen.getByAltText("Porto")).toHaveAttribute("src", "https://cdn.test/a/b.jpg");
    expect(screen.queryByAltText("Kyoto")).not.toBeInTheDocument();
  });

  it("filters by kind tab", async () => {
    const { user } = renderModal();
    await screen.findByText("Kyoto");
    await user.click(screen.getByRole("button", { name: "Wishlist" }));
    expect(screen.getByText("Kyoto")).toBeInTheDocument();
    expect(screen.queryByText("Lisbon trip")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Memories" }));
    expect(screen.queryByText("Kyoto")).not.toBeInTheDocument();
    expect(screen.getByText("Porto")).toBeInTheDocument();
  });

  it("filters by title or note, case-insensitively", async () => {
    const { user } = renderModal();
    await screen.findByText("Kyoto");
    const box = screen.getByPlaceholderText("Filter by title or note");
    await user.type(box, "NATA");
    expect(screen.getByText("Lisbon trip")).toBeInTheDocument();
    expect(screen.queryByText("Kyoto")).not.toBeInTheDocument();
  });

  it("combines kind and text filters, with a context-specific empty message", async () => {
    const { user } = renderModal();
    await screen.findByText("Kyoto");
    await user.click(screen.getByRole("button", { name: "Wishlist" }));
    await user.type(screen.getByPlaceholderText("Filter by title or note"), "lisbon");
    expect(screen.getByText("No wishlist pins yet")).toBeInTheDocument();
  });

  it("explains an empty database", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ pins: [] }) });
    renderModal();
    expect(await screen.findByText("No pins yet")).toBeInTheDocument();
  });

  it("shows the API error and no grid when loading fails", async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: "Too many requests" }) });
    renderModal();
    expect(await screen.findByText("Too many requests")).toBeInTheDocument();
    expect(screen.queryByText("No pins yet")).not.toBeInTheDocument();
  });

  it("reports the clicked pin's id, and closes via × or backdrop", async () => {
    const { user, onSelectPin, onClose } = renderModal();
    await user.click(await screen.findByRole("button", { name: /Kyoto/ }));
    expect(onSelectPin).toHaveBeenCalledWith("2");
    await user.click(screen.getByRole("button", { name: "×" }));
    await user.click(document.querySelector(".modal-backdrop")!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("doesn't update state after unmount (no act warnings from a late response)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    let resolve!: (v: unknown) => void;
    fetchMock.mockReturnValue(new Promise((r) => (resolve = r)));
    const { unmount } = render(<AllPinsModal onClose={() => {}} onSelectPin={() => {}} />);
    unmount();
    resolve({ ok: true, json: async () => ({ pins }) });
    await new Promise((r) => setTimeout(r, 0));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
