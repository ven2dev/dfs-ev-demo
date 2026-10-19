import { describe, it, expect, vi, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useAppStore } from "@/store";
import { useInitAuth } from "./useInitAuth";

type FakeUser = { uid: string; displayName: string | null; providerData: { providerId: string }[] };

const { setCurrentUid, getCurrentUid } = vi.hoisted(() => {
  let uid: string | null = null;
  return {
    setCurrentUid: (u: string | null) => {
      uid = u;
    },
    getCurrentUid: () => uid,
  };
});

let authStateCallback: ((user: FakeUser | null) => void) | null = null;

vi.mock("firebase/auth", () => ({
  onAuthStateChanged: (_auth: unknown, cb: (user: FakeUser | null) => void) => {
    authStateCallback = cb;
    return () => {
      authStateCallback = null;
    };
  },
}));

// currentUser mirrors setCurrentUid, set immediately before each simulated
// sign-in -- matching real Firebase, where auth.currentUser has already
// updated by the time onAuthStateChanged's callback fires.
vi.mock("@/lib/firebaseClient", () => ({
  getFirebaseAuth: () => ({
    get currentUser() {
      const uid = getCurrentUid();
      return uid ? { uid, getIdToken: async () => "fake-token" } : null;
    },
  }),
}));

const initialState = useAppStore.getState();

afterEach(() => {
  useAppStore.setState(initialState, true);
  authStateCallback = null;
  setCurrentUid(null);
  vi.unstubAllGlobals();
});

const fakeUser = (uid: string): FakeUser => ({
  uid,
  displayName: uid,
  providerData: [{ providerId: "google.com" }],
});

describe("useInitAuth: stale-fetch-response guard", () => {
  it("discards a slow /api/user-data response for a uid that's no longer current", async () => {
    const pending: Record<string, (response: unknown) => void> = {};
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/user-data") {
        const uid = useAppStore.getState().uid!;
        return new Promise((resolve) => {
          pending[uid] = () =>
            resolve({ ok: true, json: async () => ({ success: true, exists: false }) });
        });
      }
      // /api/goal (persistDefaultGoal) -- not the focus of this test.
      void init;
      return Promise.resolve({ ok: true, json: async () => ({ success: true }) });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderHook(() => useInitAuth());

    setCurrentUid("uid-1");
    act(() => authStateCallback!(fakeUser("uid-1")));
    await waitFor(() => expect(pending["uid-1"]).toBeDefined());
    expect(useAppStore.getState().dataVerified).toBe(false);

    // Switch to a second account before uid-1's fetch resolves.
    setCurrentUid("uid-2");
    act(() => authStateCallback!(fakeUser("uid-2")));
    await waitFor(() => expect(pending["uid-2"]).toBeDefined());

    // Now let the STALE uid-1 response land, after uid-2 is current.
    await act(async () => {
      pending["uid-1"]({});
      await Promise.resolve();
    });

    expect(useAppStore.getState().uid).toBe("uid-2");
    // Must still reflect uid-2's own (still in-flight) fetch, not have
    // been flipped true by uid-1's late, discarded response.
    expect(useAppStore.getState().dataVerified).toBe(false);

    // uid-2's own response now lands and IS applied.
    await act(async () => {
      pending["uid-2"]({});
      await Promise.resolve();
    });
    await waitFor(() => expect(useAppStore.getState().dataVerified).toBe(true));
  });
});
