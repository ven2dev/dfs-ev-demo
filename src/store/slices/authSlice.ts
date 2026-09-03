import type { AuthStatus } from "@/types";
import type { StateCreator } from "zustand";
import type { AppState } from "../types";

export interface AuthSlice {
  uid: string | null;
  displayName: string | null;
  authStatus: AuthStatus;
  setUser: (user: { uid: string; displayName: string | null } | null) => void;
}

export const createAuthSlice: StateCreator<AppState, [], [], AuthSlice> = (
  set
) => ({
  uid: null,
  displayName: null,
  authStatus: "loading",
  setUser: (user) =>
    set(
      user
        ? { uid: user.uid, displayName: user.displayName, authStatus: "signed-in" }
        : { uid: null, displayName: null, authStatus: "signed-out" }
    ),
});
