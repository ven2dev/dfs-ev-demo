"use client";

import { signOut } from "firebase/auth";
import { getFirebaseAuth } from "@/lib/firebaseClient";
import { useSetAuthError } from "./hooks";

// Shared by AuthStatus's dropdown and the /account page -- both need the
// exact same sign-out behavior, not two copies that could drift.
export const useSignOut = () => {
  const setAuthError = useSetAuthError();

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
  };
};
