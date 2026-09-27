import { describe, it, expect, vi } from "vitest";
import { toggleWatchedProp, type WatchlistToggleDeps } from "./watchlistToggle.ts";
import type { WatchedProp } from "@/types";

const newEntry: WatchedProp = {
  propId: "prop-1",
  evScore: { modelProb: 0, impliedProb: 0, edge: 0 },
  evHistory: [],
};

// A tiny in-memory watchlist + uid, standing in for the real store --
// setUid lets a test simulate the signed-in account changing mid-flight.
const makeFakeStore = (uid: string | null) => {
  let currentUid = uid;
  const watchlist = new Map<string, WatchedProp>();
  return {
    setUid: (next: string | null) => {
      currentUid = next;
    },
    watchlist,
    deps: (submit: WatchlistToggleDeps["submit"]): WatchlistToggleDeps => ({
      getUid: () => currentUid,
      getWatchlistEntry: (propId) => watchlist.get(propId),
      setWatchlistEntry: (propId, entry) => {
        if (entry) watchlist.set(propId, entry);
        else watchlist.delete(propId);
      },
      submit,
    }),
  };
};

describe("toggleWatchedProp", () => {
  it("optimistically adds the entry, then leaves it in place on success", async () => {
    const store = makeFakeStore("uid-1");
    const submit = vi.fn().mockResolvedValue({ success: true });

    const result = await toggleWatchedProp("prop-1", newEntry, store.deps(submit));

    expect(result).toEqual({ status: "success" });
    expect(store.watchlist.get("prop-1")).toEqual(newEntry);
    expect(submit).toHaveBeenCalledWith("prop-1", false);
  });

  it("optimistically removes an already-watched entry, then leaves it removed on success", async () => {
    const store = makeFakeStore("uid-1");
    store.watchlist.set("prop-1", newEntry);
    const submit = vi.fn().mockResolvedValue({ success: true });

    const result = await toggleWatchedProp("prop-1", newEntry, store.deps(submit));

    expect(result).toEqual({ status: "success" });
    expect(store.watchlist.has("prop-1")).toBe(false);
    expect(submit).toHaveBeenCalledWith("prop-1", true);
  });

  it("reverts the optimistic add and reports the failure when the request fails", async () => {
    const store = makeFakeStore("uid-1");
    const submit = vi.fn().mockResolvedValue({ success: false, reason: "Server exploded" });

    const result = await toggleWatchedProp("prop-1", newEntry, store.deps(submit));

    expect(result).toEqual({
      status: "reverted",
      wasWatching: false,
      cause: new Error("Server exploded"),
    });
    expect(store.watchlist.has("prop-1")).toBe(false);
  });

  it("reverts the optimistic remove back to the prior entry when the request fails", async () => {
    const store = makeFakeStore("uid-1");
    store.watchlist.set("prop-1", newEntry);
    const submit = vi.fn().mockResolvedValue({ success: false });

    const result = await toggleWatchedProp("prop-1", newEntry, store.deps(submit));

    expect(result.status).toBe("reverted");
    expect(store.watchlist.get("prop-1")).toEqual(newEntry);
  });

  it("reports 'stale' instead of reverting when the signed-in uid changed while the request was in flight", async () => {
    const store = makeFakeStore("uid-1");
    const submit = vi.fn().mockImplementation(async () => {
      // The account changes while this request is still pending --
      // the newer uid's own action now owns the watchlist.
      store.setUid("uid-2");
      return { success: false, reason: "boom" };
    });

    const result = await toggleWatchedProp("prop-1", newEntry, store.deps(submit));

    expect(result).toEqual({ status: "stale" });
    // Never reverted -- that would stomp on uid-2's own watchlist state.
    expect(store.watchlist.has("prop-1")).toBe(true);
  });
});
