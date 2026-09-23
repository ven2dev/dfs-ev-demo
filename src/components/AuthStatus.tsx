"use client";

// signInWithPopup, not signInWithRedirect: the redirect flow depends on
// storage persisting across a full top-level navigation to Google and
// back, which is exactly what current Chrome's third-party storage
// restrictions break -- confirmed via direct testing, in both a normal
// and an Incognito window, after ruling out every config-level cause
// (API key, project setup, JS origins, redirect URIs, consent screen
// status). Popup avoids that dependency entirely: the original tab
// stays alive and gets the result via postMessage instead.
import { useEffect } from "react";
import { signInWithPopup, signOut } from "firebase/auth";
import { getFirebaseAuth, googleProvider } from "@/lib/firebaseClient";
import {
  useAuthError,
  useAuthStatus,
  useDisplayName,
  useSetAuthError,
} from "@/store/hooks";

export function AuthStatus() {
  const authStatus = useAuthStatus();
  const displayName = useDisplayName();
  const authError = useAuthError();
  const setAuthError = useSetAuthError();

  // handleSignIn clears authError at the START of each attempt, but a
  // real Firebase quirk means the popup's own promise can still reject
  // (setting a "Sign-in failed" error) even though the separate
  // onAuthStateChanged listener reports success moments later -- these
  // are two independent async paths with no guaranteed ordering. This is
  // a genuine effect (reconciling this component with authStatus, which
  // lives in an external store, not local state) -- not the "derive one
  // piece of local state from another" anti-pattern the set-state-in-
  // effect lint rule warns about. An earlier attempt at this used
  // React's "adjust state during render" pattern instead, which is only
  // safe for a component's OWN useState/useReducer -- calling into an
  // external store's setter mid-render risks tearing/inconsistent
  // snapshots for other components rendering concurrently.
  useEffect(() => {
    if (authStatus === "signed-in") setAuthError(null);
  }, [authStatus, setAuthError]);

  const handleSignIn = () => {
    setAuthError(null);
    const authInstance = getFirebaseAuth();
    if (!authInstance) {
      setAuthError("Sign-in is currently unavailable.");
      return;
    }
    signInWithPopup(authInstance, googleProvider).catch((err) => {
      setAuthError("Sign-in failed. Try again.");
      console.error("[AuthStatus] sign-in failed:", err);
    });
  };

  const handleSignOut = () => {
    setAuthError(null);
    const authInstance = getFirebaseAuth();
    if (!authInstance) {
      setAuthError("Sign-out is currently unavailable.");
      return;
    }
    signOut(authInstance).catch((err) => {
      setAuthError("Sign-out failed. Try again.");
      console.error("[AuthStatus] sign-out failed:", err);
    });
  };

  if (authStatus === "loading") {
    return <span className="text-sm text-zinc-500">…</span>;
  }

  if (authStatus === "unavailable") {
    return (
      <div className="flex flex-col items-end gap-1">
        <span className="text-sm text-zinc-500">Sign-in unavailable</span>
        {authError && <p className="text-xs text-red-600">{authError}</p>}
      </div>
    );
  }

  if (authStatus === "signed-in") {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-2 text-sm">
          <span>{displayName ?? "Signed in"}</span>
          <button
            type="button"
            onClick={handleSignOut}
            className="rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            Sign out
          </button>
        </div>
        {authError && <p className="text-xs text-red-600">{authError}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={handleSignIn}
        className="rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
      >
        Sign in with Google
      </button>
      {authError && <p className="text-xs text-red-600">{authError}</p>}
    </div>
  );
}
