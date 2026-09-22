"use client";

import { useEffect } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { getFirebaseAuth } from "@/lib/firebaseClient";
import { getAuthHeaders } from "@/lib/authHeaders";
import type { WatchedProp } from "@/types";
import { useAppStore } from "./index";
import { useAuthStatus, useSetUser, useUid } from "./hooks";

// The old persist middleware wrote here before this ticket removed it.
// Only watchlist is worth migrating -- goal has never had any real
// per-user content (its only writer is page.tsx's demo auto-seed effect,
// the same canned value for everyone), so a "migrated" goal would just be
// that same placeholder copied into Firestore for no benefit.
const LEGACY_STORAGE_KEY = "dfs-ev-demo-storage";

const readLegacyWatchlistPropIds = (): string[] => {
  const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Object.keys(parsed?.state?.watchlist ?? {});
  } catch {
    return [];
  }
};

const fetchUserData = async (uid: string) => {
  const authInstance = getFirebaseAuth();
  // Defends against a real race, not a hypothetical one: if the signed-in
  // user changed between syncDataFromServer capturing this uid and this
  // call running, auth.currentUser would silently be a DIFFERENT user's
  // token than the one this fetch is supposed to be for.
  if (authInstance?.currentUser?.uid !== uid) return null;
  const idToken = await authInstance.currentUser.getIdToken();
  if (!idToken) return null;

  const res = await fetch("/api/user-data", {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (!res.ok) return null;
  const body = await res.json();
  return body.success ? body : null;
};

// Seeds Firestore from whatever's left in the old localStorage key, one
// POST per previously-watched propId (reusing the real route rather than
// writing to Firestore directly -- it already knows how to construct a
// fresh placeholder entry, the same shape a brand-new watch produces).
// Stale evScore/evHistory values aren't worth preserving verbatim: the
// live SSE stream overwrites them within moments of the page loading
// anyway, so only the *set of watched propIds* is real data worth saving.
const migrateLegacyWatchlist = async (): Promise<Record<string, WatchedProp>> => {
  const propIds = readLegacyWatchlistPropIds();
  localStorage.removeItem(LEGACY_STORAGE_KEY);
  if (propIds.length === 0) return {};

  const headers = { "Content-Type": "application/json", ...(await getAuthHeaders()) };
  const migrated: Record<string, WatchedProp> = {};
  for (const propId of propIds) {
    const res = await fetch("/api/watchlist", {
      method: "POST",
      headers,
      body: JSON.stringify({ propId }),
    });
    const data = await res.json();
    if (data.success) {
      migrated[propId] = { propId, evScore: { modelProb: 0, impliedProb: 0, edge: 0 }, evHistory: [] };
    }
  }
  return migrated;
};

// Firestore's per-uid document path is the ownership boundary now -- no
// local heuristic needed, unlike the old dataOwnerUid comparison. Every
// uid change (including to/from signed-out) resets goal/watchlist to a
// blank slate first, since nothing is persisted locally anymore; a
// signed-in uid then gets its real data hydrated from its own Firestore
// document, if one exists yet.
const syncDataFromServer = async (uid: string | null) => {
  if (!uid) {
    useAppStore.setState({ goal: null, watchlist: {}, dataVerified: true });
    return;
  }

  useAppStore.setState({ goal: null, watchlist: {}, dataVerified: false });

  const result = await fetchUserData(uid);
  // Ignore a stale response if the signed-in user changed again while
  // this fetch was in flight -- the newer uid's own call is the one that
  // should win.
  if (useAppStore.getState().uid !== uid) return;

  if (result?.exists) {
    useAppStore.setState({
      goal: result.data.goal ?? null,
      watchlist: result.data.watchlist ?? {},
      ...(result.data.matchupConfig ? { matchupConfig: result.data.matchupConfig } : {}),
    });
  } else {
    const migratedWatchlist = await migrateLegacyWatchlist();
    if (useAppStore.getState().uid !== uid) return;
    useAppStore.setState({ watchlist: migratedWatchlist });
  }

  useAppStore.setState({ dataVerified: true });
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
