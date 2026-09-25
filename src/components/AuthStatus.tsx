"use client";

// signInWithPopup, not signInWithRedirect: the redirect flow depends on
// storage persisting across a full top-level navigation to Google and
// back, which is exactly what current Chrome's third-party storage
// restrictions break -- confirmed via direct testing, in both a normal
// and an Incognito window, after ruling out every config-level cause
// (API key, project setup, JS origins, redirect URIs, consent screen
// status). Popup avoids that dependency entirely: the original tab
// stays alive and gets the result via postMessage instead.
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { signInWithPopup } from "firebase/auth";
import { getFirebaseAuth, googleProvider } from "@/lib/firebaseClient";
import {
  useAuthError,
  useAuthStatus,
  useDisplayName,
  useSetAuthError,
} from "@/store/hooks";
import { useSignOut } from "@/store/useSignOut";

// Generic, same for every user -- not a fetched Google profile photo.
// Deliberate choice: see #22's triage discussion.
const AvatarIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="currentColor"
    className="h-full w-full text-zinc-500 dark:text-zinc-400"
    aria-hidden="true"
  >
    <circle cx="12" cy="8" r="4" />
    <path d="M4 20c0-4.418 3.582-8 8-8s8 3.582 8 8v.5a.5.5 0 0 1-.5.5h-15a.5.5 0 0 1-.5-.5V20z" />
  </svg>
);

export const AuthStatus = () => {
  const authStatus = useAuthStatus();
  const displayName = useDisplayName();
  const authError = useAuthError();
  const setAuthError = useSetAuthError();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

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

  // Standard dropdown affordances: closes on an outside click or Escape.
  // Only attached while actually open, not on every render.
  useEffect(() => {
    if (!menuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

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

  const signOut = useSignOut();
  const handleSignOut = () => {
    setMenuOpen(false);
    signOut();
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
      <div className="relative flex flex-col items-end gap-1" ref={menuRef}>
        <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          className="h-8 w-8 overflow-hidden rounded-full border border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          <AvatarIcon />
        </button>

        {menuOpen && (
          <div
            role="menu"
            className="absolute top-10 right-0 z-10 w-48 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
          >
            <p className="truncate px-3 py-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">
              {displayName ?? "Signed in"}
            </p>
            <Link
              href="/account"
              role="menuitem"
              onClick={() => setMenuOpen(false)}
              className="block px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Account
            </Link>
            <button
              type="button"
              role="menuitem"
              onClick={handleSignOut}
              className="block w-full px-3 py-2 text-left text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Sign out
            </button>
          </div>
        )}
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
};
