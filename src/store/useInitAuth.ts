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

// Best-effort: never throws, so a network failure here can never hang
// syncDataFromServer's caller waiting on it. Returns the persisted goal
// on success, null on any failure (network error or a non-success
// response) -- callers must treat null as "didn't happen this time,"
// not as an error to surface, since this always gets a retry on the
// next load via the self-heal check in the "found" branch below.
const persistDefaultGoal = async (uid: string): Promise<typeof mockGoal | null> => {
  try {
    const headers = { "Content-Type": "application/json", ...(await getAuthHeaders()) };
    const res = await fetch("/api/goal", {
      method: "PUT",
      headers,
      body: JSON.stringify(mockGoal),
    });
    if (useAppStore.getState().uid !== uid) return null;
    if (!res.ok) return null;
    const data = await res.json();
    return data.success ? mockGoal : null;
  } catch (err) {
    console.error("[useInitAuth] persisting default goal failed:", err);
    return null;
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
    const existingGoal = (result.data.goal as typeof mockGoal | null) ?? null;
    useAppStore.setState({
      goal: existingGoal,
      watchlist: (result.data.watchlist as Record<string, WatchedProp>) ?? {},
      ...(matchupConfig ? { matchupConfig } : {}),
      dataVerified: true,
    });

    // Self-heals a PRIOR failed goal write, whether this account's
    // document is genuinely brand new or just missing this one field --
    // "no real goal recorded yet" is the actual trigger, not "the whole
    // document didn't exist." Runs in the background: dataVerified is
    // already true above, this only backfills for the *next* load if it
    // succeeds, it doesn't block rendering this one.
    if (!existingGoal) {
      persistDefaultGoal(uid).then((persisted) => {
        if (persisted && useAppStore.getState().uid === uid) {
          useAppStore.setState({ goal: persisted });
        }
      });
    }
    return;
  }

  // result.status === "not-found": genuinely confirmed brand-new user.
  // Issue #21's AC requires a user's goal to survive a device switch --
  // even though the content is still just the shared demo placeholder
  // (no real goal-editing UI exists yet), it has to actually be written
  // to and read from Firestore, not independently re-seeded fresh on
  // every device. Seed it here rather than leaving it to page.tsx's
  // local-only effect, which can't make it durable. persistDefaultGoal
  // never throws, so this can't leave dataVerified stuck false forever;
  // a failure here still gets picked up by the self-heal above on the
  // very next load, once the document exists with watchlist/matchupConfig
  // but no goal.
  const persistedGoal = await persistDefaultGoal(uid);
  if (useAppStore.getState().uid !== uid) return;
  useAppStore.setState({ goal: persistedGoal, watchlist: {}, dataVerified: true });
};

// Pre-#21 builds wrote here via the old persist middleware. Nothing
// reads it anymore -- not migrated (see #21's amended AC), just cleaned
// up so it doesn't sit around indefinitely for no reason.
const LEGACY_STORAGE_KEY = "dfs-ev-demo-storage";

export const useInitAuth = () => {
  const setUser = useSetUser();
  const authStatus = useAuthStatus();
  const uid = useUid();

  useEffect(() => {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  }, []);

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
