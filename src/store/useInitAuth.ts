"use client";

import { useEffect } from "react";
import { getRedirectResult, onAuthStateChanged } from "firebase/auth";
import { auth } from "@/lib/firebaseClient";
import { useSetUser } from "./hooks";

export function useInitAuth() {
  const setUser = useSetUser();

  useEffect(() => {
    // onAuthStateChanged below also fires once a signInWithRedirect
    // completes, but only this call surfaces redirect-specific errors
    // (e.g. account-exists-with-different-credential).
    getRedirectResult(auth).catch((err) => {
      console.error("[useInitAuth] redirect sign-in failed:", err);
    });

    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setUser(user ? { uid: user.uid, displayName: user.displayName } : null);
    });

    return unsubscribe;
  }, [setUser]);
}
