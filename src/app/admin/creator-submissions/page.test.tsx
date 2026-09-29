import { describe, it, expect, vi, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { useAppStore } from "@/store";
import CreatorSubmissionsPage from "./page";

vi.mock("@/lib/authHeaders", () => ({ getAuthHeaders: async () => ({}) }));

const initialState = useAppStore.getState();

afterEach(() => {
  useAppStore.setState(initialState, true);
  vi.unstubAllGlobals();
});

const signIn = (uid: string) => {
  useAppStore.setState({ authStatus: "signed-in", uid });
};

const adminSubmissionsResponse = {
  status: 200,
  json: async () => ({
    success: true,
    submissions: [
      {
        id: 1,
        channelName: "Creator A",
        videoUrl: null,
        videoTitle: "Admin-only title",
        submittedAt: "2026-09-01T00:00:00.000Z",
      },
    ],
  }),
};

const forbiddenResponse = {
  status: 403,
  json: async () => ({ success: false, reason: "Forbidden" }),
};

describe("CreatorSubmissionsPage", () => {
  // Reproduces a real review finding: authSlice's setUser sets
  // authStatus: "signed-in" regardless of whether the uid actually
  // changed, so a direct account switch (no intermediate signed-out
  // state -- exactly what this test does) never changes authStatus at
  // all. An effect keyed only on authStatus would never re-fetch, and
  // the PREVIOUS admin's cached submissions would keep rendering under
  // the new, non-admin account.
  it("does not leak the previous admin's submissions after switching to a different signed-in account", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(adminSubmissionsResponse)
      .mockResolvedValueOnce(forbiddenResponse);
    vi.stubGlobal("fetch", fetchMock);

    signIn("admin-uid");
    render(<CreatorSubmissionsPage />);

    await waitFor(() => expect(screen.getByText(/Admin-only title/)).toBeInTheDocument());

    // Direct account switch -- authStatus stays "signed-in" throughout,
    // only uid changes.
    act(() => signIn("someone-else-uid"));

    await waitFor(() => expect(screen.getByText("Not authorized.")).toBeInTheDocument());
    expect(screen.queryByText(/Admin-only title/)).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
