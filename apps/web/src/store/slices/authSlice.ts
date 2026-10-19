import type { AuthStatus } from "@/types";
import type { StateCreator } from "zustand";
import type { AppState } from "../types";

export interface AuthSlice {
  uid: string | null;
  displayName: string | null;
  // e.g. "google.com" -- Firebase's own provider id format. Google-only
  // for now, but stored as whatever Firebase reports rather than a
  // hardcoded "Google" literal, so this doesn't need revisiting the day
  // a second provider is added.
  providerId: string | null;
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
  // Monotonic counter, bumped on every REAL identity transition (only
  // when uid actually changes). Closes an ABA gap plain uid-equality
  // can't see: a caller comparing "current uid === uid captured at the
  // start of some async flow" can't tell "identity never changed" apart
  // from "changed away and changed back to the same uid" -- e.g. a
  // multi-admin-account setup where account A starts a write, account B
  // signs in and its own request resolves using B's credentials, then A
  // signs back in before that resolves. Comparing generation numbers
  // instead of uids catches that: it moved, even though the endpoints
  // match. Any admin-gated page with an async write + refresh should
  // capture this at the start and re-check it before applying a result.
  identityGeneration: number;
  setUser: (
    user: { uid: string; displayName: string | null; providerId: string | null } | null
  ) => void;
  setAuthError: (error: string | null) => void;
}

export const createAuthSlice: StateCreator<AppState, [], [], AuthSlice> = (
  set
) => ({
  uid: null,
  displayName: null,
  providerId: null,
  authStatus: "loading",
  authError: null,
  dataVerified: false,
  dataLoadError: null,
  identityGeneration: 0,
  setUser: (user) =>
    set((state) => {
      const nextUid = user?.uid ?? null;
      const identityFields = user
        ? {
            uid: user.uid,
            displayName: user.displayName,
            providerId: user.providerId,
            authStatus: "signed-in" as const,
          }
        : {
            uid: null,
            displayName: null,
            providerId: null,
            authStatus: "signed-out" as const,
          };
      // uid changing must flip dataVerified false in this SAME update,
      // not in a later effect -- otherwise a render can land between the
      // two with the new uid already visible but the old uid's
      // "verified" flag still true, painting the wrong account's data
      // for a frame. useInitAuth flips it back to true once it's actually
      // fetched (or confirmed empty) this new uid's real data. Same
      // update also bumps identityGeneration -- guarded the same way
      // (only on a REAL transition), so a redundant setUser call with
      // the same uid doesn't spuriously invalidate an in-flight check.
      return state.uid === nextUid
        ? identityFields
        : { ...identityFields, dataVerified: false, identityGeneration: state.identityGeneration + 1 };
    }),
  setAuthError: (error) => set({ authError: error }),
});
