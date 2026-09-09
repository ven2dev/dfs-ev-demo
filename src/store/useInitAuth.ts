"use client";

import { useEffect } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { getFirebaseAuth } from "@/lib/firebaseClient";
import { useAppStore } from "./index";
import { useHasHydrated } from "./useHasHydrated";
import { useAuthStatus, useSetUser, useUid } from "./hooks";

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
  const authStatus = useAuthStatus();
  const uid = useUid();

  useEffect(() => {
    const authInstance = getFirebaseAuth();
    if (!authInstance) {
      // Config missing/invalid -- degrade instead of hanging: authStatus
      // flipping off "loading" is what unblocks dataVerified and the
      // rest of the app, including the signed-out demo preview, which
      // should still work even if sign-in itself is broken.
      useAppStore.setState({
        authStatus: "unavailable",
        authError: "Sign-in is currently unavailable.",
      });
      return;
    }

    // signInWithPopup resolves/rejects directly from its own call site
    // (handled in AuthStatus), unlike signInWithRedirect which needs a
    // separate getRedirectResult() retrieval after the page reloads.
    // onAuthStateChanged alone is sufficient here.
    const unsubscribe = onAuthStateChanged(authInstance, (user) => {
      setUser(user ? { uid: user.uid, displayName: user.displayName } : null);
    });

    return unsubscribe;
  }, [setUser]);

  // Ownership verification is only meaningful once BOTH readiness signals
  // are true: Firebase has reported who's signed in (authStatus flips off
  // "loading" the instant setUser above runs) and Zustand has finished
  // rehydrating persisted state. These are two independent async
  // processes with no guaranteed order -- rather than manually threading
  // a ref between two effects to catch "whichever resolves second", this
  // single effect's dependency array does that coordination: it re-runs
  // on every change to either signal, and only actually acts once both
  // are true. The same effect also covers an in-session account switch,
  // since uid changing re-runs it again after the initial verification.
  useEffect(() => {
    if (authStatus === "loading" || !hasHydrated) return;
    syncDataOwnership(uid);
  }, [authStatus, uid, hasHydrated]);
}
