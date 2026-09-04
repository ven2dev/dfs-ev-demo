"use client";

import { useEffect, useRef } from "react";
import { getRedirectResult, onAuthStateChanged } from "firebase/auth";
import { auth } from "@/lib/firebaseClient";
import { useAppStore } from "./index";
import { useHasHydrated } from "./useHasHydrated";
import { useSetUser } from "./hooks";

// goal/watchlist are tagged with the uid that owns them (dataOwnerUid,
// itself persisted alongside them). Comparing against that persisted tag,
// rather than only an in-memory "uid seen earlier this session", is what
// catches stale data left behind by a PRIOR browser session -- not just
// an account switch that happens while the app is running.
function syncDataOwnership(nextUid: string | null) {
  const mismatch = useAppStore.getState().dataOwnerUid !== nextUid;
  // One atomic update: clearing goal/watchlist, recording the new owner,
  // and marking verification done all land in a single render rather
  // than a clear-then-verify sequence that itself has a gap.
  useAppStore.setState({
    ...(mismatch ? { goal: null, watchlist: {} } : {}),
    dataOwnerUid: nextUid,
    dataVerified: true,
  });
}

export function useInitAuth() {
  const setUser = useSetUser();
  const hasHydrated = useHasHydrated();
  // undefined = Firebase hasn't reported an auth state yet. The ownership
  // check is only meaningful once BOTH this and hydration are resolved --
  // whichever of the two finishes second is what actually runs it.
  const latestUid = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    // onAuthStateChanged below also fires once a signInWithRedirect
    // completes, but only this call surfaces redirect-specific errors
    // (e.g. account-exists-with-different-credential). This is the one
    // path Firebase's own docs call out as needing explicit handling --
    // signInWithRedirect itself just navigates away, it doesn't reject
    // for a failed sign-in the way a popup flow would.
    getRedirectResult(auth).catch((err) => {
      useAppStore.getState().setAuthError("Sign-in failed. Try again.");
      console.error("[useInitAuth] redirect sign-in failed:", err);
    });

    const unsubscribe = onAuthStateChanged(auth, (user) => {
      const nextUid = user?.uid ?? null;
      latestUid.current = nextUid;
      setUser(user ? { uid: user.uid, displayName: user.displayName } : null);
      if (useAppStore.persist?.hasHydrated()) {
        syncDataOwnership(nextUid);
      }
    });

    return unsubscribe;
  }, [setUser]);

  // Catches the reverse ordering: hydration finishing AFTER Firebase has
  // already reported who's signed in. Runs once, right when hydration
  // completes, using whatever the listener above has already recorded.
  useEffect(() => {
    if (hasHydrated && latestUid.current !== undefined) {
      syncDataOwnership(latestUid.current);
    }
  }, [hasHydrated]);
}
