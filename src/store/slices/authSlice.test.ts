import { describe, it, expect } from "vitest";
import { useAppStore } from "../index";

const initialState = useAppStore.getState();

const resetStore = () => useAppStore.setState(initialState, true);

describe("authSlice: setUser", () => {
  it("a new uid signing in resets dataVerified to false in the same update", () => {
    resetStore();
    useAppStore.setState({ dataVerified: true });

    useAppStore.getState().setUser({ uid: "uid-1", displayName: "A", providerId: "google.com" });

    const state = useAppStore.getState();
    expect(state.uid).toBe("uid-1");
    expect(state.dataVerified).toBe(false);
  });

  it("signing out (a uid -> null transition) also resets dataVerified to false", () => {
    resetStore();
    useAppStore.getState().setUser({ uid: "uid-1", displayName: "A", providerId: "google.com" });
    useAppStore.setState({ dataVerified: true });

    useAppStore.getState().setUser(null);

    const state = useAppStore.getState();
    expect(state.uid).toBe(null);
    expect(state.authStatus).toBe("signed-out");
    expect(state.dataVerified).toBe(false);
  });

  it("re-reporting the SAME uid does not disturb dataVerified once it's already been set true", () => {
    resetStore();
    useAppStore.getState().setUser({ uid: "uid-1", displayName: "A", providerId: "google.com" });
    // Simulates useInitAuth having already resolved this uid's real data.
    useAppStore.setState({ dataVerified: true });

    // onAuthStateChanged can fire again for the same already-signed-in
    // user (e.g. a token refresh) -- that must not re-trigger the
    // loading shell for data that's already been verified.
    useAppStore.getState().setUser({ uid: "uid-1", displayName: "A", providerId: "google.com" });

    expect(useAppStore.getState().dataVerified).toBe(true);
  });

  it("switching directly from one signed-in uid to another resets dataVerified", () => {
    resetStore();
    useAppStore.getState().setUser({ uid: "uid-1", displayName: "A", providerId: "google.com" });
    useAppStore.setState({ dataVerified: true });

    useAppStore.getState().setUser({ uid: "uid-2", displayName: "B", providerId: "google.com" });

    const state = useAppStore.getState();
    expect(state.uid).toBe("uid-2");
    expect(state.dataVerified).toBe(false);
  });
});
