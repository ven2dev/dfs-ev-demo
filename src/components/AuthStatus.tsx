"use client";

import { signInWithRedirect, signOut } from "firebase/auth";
import { auth, googleProvider } from "@/lib/firebaseClient";
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

  const handleSignIn = () => {
    setAuthError(null);
    signInWithRedirect(auth, googleProvider).catch((err) => {
      setAuthError("Sign-in failed. Try again.");
      console.error("[AuthStatus] sign-in failed:", err);
    });
  };

  const handleSignOut = () => {
    setAuthError(null);
    signOut(auth).catch((err) => {
      setAuthError("Sign-out failed. Try again.");
      console.error("[AuthStatus] sign-out failed:", err);
    });
  };

  if (authStatus === "loading") {
    return <span className="text-sm text-zinc-500">…</span>;
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
