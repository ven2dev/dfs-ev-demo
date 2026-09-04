"use client";

import { useEffect } from "react";
import { getRedirectResult, onAuthStateChanged } from "firebase/auth";
import { auth } from "@/lib/firebaseClient";
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
