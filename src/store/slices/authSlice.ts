import type { AuthStatus } from "@/types";
import type { StateCreator } from "zustand";
import type { AppState } from "../types";

export interface AuthSlice {
  uid: string | null;
  displayName: string | null;
  authStatus: AuthStatus;
  authError: string | null;
  // False until useInitAuth has resolved this uid's real data from
  // Firestore (or confirmed there's no uid to resolve for). Components
  // reading goal/watchlist must wait for this -- nothing is persisted
  // locally anymore, so there's no stale data to leak, but there IS a
  // brief window where the previous account's in-memory state hasn't
  // been cleared yet.
  dataVerified: boolean;
  // Set when useInitAuth's Firestore fetch genuinely fails (network/
  // server error) -- distinct from dataVerified staying false while a
  // fetch is merely in flight. Lets the loading shell show a real error
  // instead of an indefinite spinner when something's actually wrong.
  dataLoadError: string | null;
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
  dataVerified: false,
  dataLoadError: null,
  setUser: (user) =>
    set((state) => {
      const nextUid = user?.uid ?? null;
      const identityFields = user
        ? { uid: user.uid, displayName: user.displayName, authStatus: "signed-in" as const }
        : { uid: null, displayName: null, authStatus: "signed-out" as const };
      // uid changing must flip dataVerified false in this SAME update,
      // not in a later effect -- otherwise a render can land between the
      // two with the new uid already visible but the old uid's
      // "verified" flag still true, painting the wrong account's data
      // for a frame. useInitAuth flips it back to true once it's actually
      // fetched (or confirmed empty) this new uid's real data.
      return state.uid === nextUid
        ? identityFields
        : { ...identityFields, dataVerified: false };
    }),
  setAuthError: (error) => set({ authError: error }),
});
