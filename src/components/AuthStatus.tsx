"use client";

import { signInWithRedirect, signOut } from "firebase/auth";
import { auth, googleProvider } from "@/lib/firebaseClient";
import { useAuthStatus, useDisplayName } from "@/store/hooks";

export function AuthStatus() {
  const authStatus = useAuthStatus();
  const displayName = useDisplayName();

  if (authStatus === "loading") {
    return <span className="text-sm text-zinc-500">…</span>;
  }

  if (authStatus === "signed-in") {
    return (
      <div className="flex items-center gap-2 text-sm">
        <span>{displayName ?? "Signed in"}</span>
        <button
          type="button"
          onClick={() => signOut(auth)}
          className="rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          Sign out
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => signInWithRedirect(auth, googleProvider)}
      className="rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
    >
      Sign in with Google
    </button>
  );
}
