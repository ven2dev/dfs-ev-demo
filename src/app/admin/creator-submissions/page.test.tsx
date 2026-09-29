import { describe, it, expect, vi, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  // Reproduces a second, deeper review finding: the first fix checked
  // the identity BEFORE awaiting the post-submit refresh, not after --
  // so an account change that happens WHILE that refresh is still in
  // flight (not just before it starts) still slipped through and
  // overwrote the new account's already-loaded state. This test holds
  // the refresh open with a manually-controlled promise specifically to
  // force that exact interleaving.
  it("does not let a submit's refresh overwrite a newer account's state if the identity changes while that refresh is still in flight", async () => {
    let resolveRefresh: (value: unknown) => void = () => {};
    const deferredRefresh = new Promise((resolve) => {
      resolveRefresh = resolve;
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(adminSubmissionsResponse) // 1: mount as admin-uid
      .mockResolvedValueOnce({
        status: 200,
        json: async () => ({ success: true, result: { status: "inserted", id: 99 } }),
      }) // 2: the POST itself
      .mockImplementationOnce(() => deferredRefresh) // 3: post-submit refresh GET -- held open
      .mockResolvedValueOnce(forbiddenResponse); // 4: the new account's own mount effect
    vi.stubGlobal("fetch", fetchMock);

    signIn("admin-uid");
    render(<CreatorSubmissionsPage />);
    await waitFor(() => expect(screen.getByText(/Admin-only title/)).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText("Channel name"), {
      target: { value: "New Creator" },
    });
    fireEvent.change(screen.getByPlaceholderText("Video URL"), {
      target: { value: "https://example.com/new" },
    });
    fireEvent.change(screen.getByPlaceholderText("Transcript text"), {
      target: { value: "some transcript" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    // The POST has resolved and the refresh (call 3) has started, but
    // we're holding it open -- switch accounts while it's still pending.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    act(() => signIn("someone-else-uid"));

    // The NEW account's own effect (call 4) completes fully first.
    await waitFor(() => expect(screen.getByText("Not authorized.")).toBeInTheDocument());

    // Only now does the stale refresh resolve, well after the new
    // account already settled.
    await act(async () => {
      resolveRefresh({
        status: 200,
        json: async () => ({
          success: true,
          submissions: [
            {
              id: 99,
              channelName: "New Creator",
              videoUrl: "https://example.com/new",
              videoTitle: "STALE TITLE",
              submittedAt: "2026-09-29T00:00:00.000Z",
            },
          ],
        }),
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("Not authorized.")).toBeInTheDocument();
    expect(screen.queryByText(/STALE TITLE/)).not.toBeInTheDocument();
  });
});
