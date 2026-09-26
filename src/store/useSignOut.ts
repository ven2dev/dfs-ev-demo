"use client";

import { useRouter } from "next/navigation";
import { signOut } from "firebase/auth";
import { getFirebaseAuth } from "@/lib/firebaseClient";
import { useSetAuthError } from "./hooks";

// Shared by AuthStatus's dropdown, the /account page's own button, and
// the delete-account flow -- all need the exact same sign-out behavior,
// not copies that could drift.
export const useSignOut = () => {
  const setAuthError = useSetAuthError();
  const router = useRouter();

  return () => {
    setAuthError(null);
    const authInstance = getFirebaseAuth();
    if (!authInstance) {
      setAuthError("Sign-out is currently unavailable.");
      return;
    }
    signOut(authInstance).catch((err) => {
      setAuthError("Sign-out failed. Try again.");
      console.error("[useSignOut] sign-out failed:", err);
    });
    // Redirect home regardless of which page sign-out was triggered
    // from -- a no-op if already on the home page, but the fix for
    // signing out on /account, which otherwise just sits there showing
    // "Sign in to view your account" with nowhere sensible to go.
    router.push("/");
  };
};
