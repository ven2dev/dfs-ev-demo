import type { AuthStatus } from "@/types";
import type { StateCreator } from "zustand";
import type { AppState } from "../types";

export interface AuthSlice {
  uid: string | null;
  displayName: string | null;
  authStatus: AuthStatus;
  authError: string | null;
  // Persisted (unlike the rest of this slice): tags which uid the
  // currently-persisted goal/watchlist belong to, so a mismatch can be
  // detected even on the very first load of a new session, not just an
  // in-session account switch. See useInitAuth.ts.
  dataOwnerUid: string | null;
  // False until useInitAuth has actually compared dataOwnerUid against
  // the real current uid at least once. Components reading goal/
  // watchlist must wait for this -- otherwise a hydration render can
  // briefly show another account's persisted data before the mismatch
  // check has had a chance to run and clear it.
  dataVerified: boolean;
  setUser: (user: { uid: string; displayName: string | null } | null) => void;
  setAuthError: (error: string | null) => void;
}

export const createAuthSlice: StateCreator<AppState, [], [], AuthSlice> = (
  set
) => ({
  uid: null,
  displayName: null,
  authStatus: "loading",
  authError: null,
  dataOwnerUid: null,
  dataVerified: false,
  setUser: (user) =>
    set(
      user
        ? { uid: user.uid, displayName: user.displayName, authStatus: "signed-in" }
        : { uid: null, displayName: null, authStatus: "signed-out" }
    ),
  setAuthError: (error) => set({ authError: error }),
});
