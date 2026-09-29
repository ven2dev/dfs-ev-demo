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

describe("authSlice: identityGeneration", () => {
  it("bumps on a real uid transition", () => {
    resetStore();
    const before = useAppStore.getState().identityGeneration;

    useAppStore.getState().setUser({ uid: "uid-1", displayName: "A", providerId: "google.com" });

    expect(useAppStore.getState().identityGeneration).toBe(before + 1);
  });

  it("does NOT bump when the same uid is re-reported (e.g. a token refresh)", () => {
    resetStore();
    useAppStore.getState().setUser({ uid: "uid-1", displayName: "A", providerId: "google.com" });
    const afterFirst = useAppStore.getState().identityGeneration;

    useAppStore.getState().setUser({ uid: "uid-1", displayName: "A", providerId: "google.com" });

    expect(useAppStore.getState().identityGeneration).toBe(afterFirst);
  });

  // The actual ABA case this field exists to catch: a caller comparing
  // uid alone ("did it end up different from where it started?") would
  // see uid-1 === uid-1 here and wrongly conclude nothing happened.
  it("ends up at a DIFFERENT generation after switching away and back to the same uid (the ABA case)", () => {
    resetStore();
    useAppStore.getState().setUser({ uid: "uid-1", displayName: "A", providerId: "google.com" });
    const startingGeneration = useAppStore.getState().identityGeneration;
    const startingUid = useAppStore.getState().uid;

    useAppStore.getState().setUser({ uid: "uid-2", displayName: "B", providerId: "google.com" });
    useAppStore.getState().setUser({ uid: "uid-1", displayName: "A", providerId: "google.com" });

    const finalState = useAppStore.getState();
    expect(finalState.uid).toBe(startingUid);
    expect(finalState.identityGeneration).not.toBe(startingGeneration);
  });
});
