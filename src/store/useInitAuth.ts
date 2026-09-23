"use client";

import { useEffect } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { getFirebaseAuth } from "@/lib/firebaseClient";
import { getAuthHeaders } from "@/lib/authHeaders";
import type { MatchupConfig, WatchedProp } from "@/types";
import { mockGoal } from "./mockData";
import { useAppStore } from "./index";
import { useAuthStatus, useSetUser, useUid } from "./hooks";

type UserDataFetchResult =
  | { status: "found"; data: { goal?: unknown; watchlist?: unknown; matchupConfig?: unknown } }
  | { status: "not-found" }
  // Genuinely unknown state -- a network/server failure, not a confirmed
  // answer. Must never be treated the same as "not-found": this uid might
  // have real saved data that a transient failure just couldn't fetch.
  | { status: "error" };

const fetchUserData = async (uid: string): Promise<UserDataFetchResult> => {
  const authInstance = getFirebaseAuth();
  // Defends against a real race, not a hypothetical one: if the signed-in
  // user changed between syncDataFromServer capturing this uid and this
  // call running, auth.currentUser would silently be a DIFFERENT user's
  // token than the one this fetch is supposed to be for.
  if (authInstance?.currentUser?.uid !== uid) return { status: "error" };

  try {
    const idToken = await authInstance.currentUser.getIdToken();
    const res = await fetch("/api/user-data", {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (!res.ok) return { status: "error" };

    const body = await res.json();
    if (!body.success) return { status: "error" };
    return body.exists ? { status: "found", data: body.data } : { status: "not-found" };
  } catch {
    return { status: "error" };
  }
};

// Firestore's per-uid document path is the ownership boundary now -- no
// local heuristic needed, unlike the old dataOwnerUid comparison. Every
// uid change (including to/from signed-out) resets goal/watchlist to a
// blank slate first, since nothing is persisted locally anymore; a
// signed-in uid then gets its real data hydrated from its own Firestore
// document, if one exists yet.
const syncDataFromServer = async (uid: string | null) => {
  if (!uid) {
    useAppStore.setState({ goal: null, watchlist: {}, dataVerified: true, dataLoadError: null });
    return;
  }

  useAppStore.setState({ goal: null, watchlist: {}, dataVerified: false, dataLoadError: null });

  const result = await fetchUserData(uid);
  // Ignore a stale response if the signed-in user changed again while
  // this fetch was in flight -- the newer uid's own call is the one that
  // should win.
  if (useAppStore.getState().uid !== uid) return;

  if (result.status === "error") {
    // We genuinely don't know this user's real state. dataVerified stays
    // false on purpose -- the loading shell stays up, now showing this
    // error, rather than the app silently presenting an unverified empty
    // account as if it were confirmed fact.
    useAppStore.setState({
      dataLoadError: "Couldn't load your saved data. Check your connection and reload.",
    });
    return;
  }

  if (result.status === "found") {
    const matchupConfig = result.data.matchupConfig as MatchupConfig | undefined;
    useAppStore.setState({
      goal: (result.data.goal as typeof mockGoal | null) ?? null,
      watchlist: (result.data.watchlist as Record<string, WatchedProp>) ?? {},
      ...(matchupConfig ? { matchupConfig } : {}),
      dataVerified: true,
    });
    return;
  }

  // result.status === "not-found": genuinely confirmed brand-new user.
  // Issue #21's AC requires a user's goal to survive a device switch --
  // even though the content is still just the shared demo placeholder
  // (no real goal-editing UI exists yet), it has to actually be written
  // to and read from Firestore, not independently re-seeded fresh on
  // every device. Seed it once, here, rather than leaving it to
  // page.tsx's local-only effect, which can't make it durable.
  const headers = { "Content-Type": "application/json", ...(await getAuthHeaders()) };
  const goalRes = await fetch("/api/goal", {
    method: "PUT",
    headers,
    body: JSON.stringify(mockGoal),
  });
  if (useAppStore.getState().uid !== uid) return;

  const goalData = await goalRes.json();
  useAppStore.setState({
    goal: goalData.success ? mockGoal : null,
    watchlist: {},
    dataVerified: true,
  });
};

export const useInitAuth = () => {
  const setUser = useSetUser();
  const authStatus = useAuthStatus();
  const uid = useUid();

  useEffect(() => {
    const authInstance = getFirebaseAuth();
    if (!authInstance) {
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

  useEffect(() => {
    if (authStatus === "loading") return;
    syncDataFromServer(uid);
  }, [authStatus, uid]);
};
