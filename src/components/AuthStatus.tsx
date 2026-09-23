"use client";

// signInWithPopup, not signInWithRedirect: the redirect flow depends on
// storage persisting across a full top-level navigation to Google and
// back, which is exactly what current Chrome's third-party storage
// restrictions break -- confirmed via direct testing, in both a normal
// and an Incognito window, after ruling out every config-level cause
// (API key, project setup, JS origins, redirect URIs, consent screen
// status). Popup avoids that dependency entirely: the original tab
// stays alive and gets the result via postMessage instead.
import { useState } from "react";
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
  // are two independent async paths with no guaranteed ordering. Adjust
  // state directly during render (React's documented pattern for this,
  // not a useEffect) the instant authStatus is OBSERVED to become
  // "signed-in": that transition means any earlier sign-in-attempt error
  // is now stale by definition. A sign-out failure is unaffected, since
  // it happens while already signed-in -- no such transition occurs.
  const [clearedForStatus, setClearedForStatus] = useState(authStatus);
  if (authStatus !== clearedForStatus) {
    setClearedForStatus(authStatus);
    if (authStatus === "signed-in") setAuthError(null);
  }

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
