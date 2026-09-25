"use client";

import { useAuthStatus, useDisplayName, useProviderId } from "@/store/hooks";
import { useSignOut } from "@/store/useSignOut";

// Firebase's raw providerId format ("google.com") isn't what a user
// should see -- Google-only for now, but a lookup rather than a
// hardcoded literal so a second provider just adds an entry here.
const PROVIDER_LABELS: Record<string, string> = {
  "google.com": "Google",
};

export default function AccountPage() {
  const authStatus = useAuthStatus();
  const displayName = useDisplayName();
  const providerId = useProviderId();
  const signOut = useSignOut();

  if (authStatus === "loading") {
    return <p className="text-sm text-zinc-500">…</p>;
  }

  if (authStatus === "unavailable") {
    return <p className="text-sm text-zinc-500">Sign-in is currently unavailable.</p>;
  }

  // Reachable by direct URL/bookmark even though there's no standing nav
  // link to it -- the avatar dropdown that links here only exists once
  // already signed in, but the route itself is still just as navigable
  // as any other.
  if (authStatus !== "signed-in") {
    return (
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Sign in to view your account.
      </p>
    );
  }

  return (
    <section className="rounded-lg border border-zinc-200 p-6 dark:border-zinc-800">
      <h2 className="text-lg font-medium">Account</h2>
      <dl className="mt-4 space-y-3 text-sm">
        <div className="flex justify-between">
          <dt className="text-zinc-500">Name</dt>
          <dd>{displayName ?? "—"}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-zinc-500">Signed in with</dt>
          <dd>{providerId ? (PROVIDER_LABELS[providerId] ?? providerId) : "—"}</dd>
        </div>
      </dl>

      <div className="mt-6 border-t border-zinc-200 pt-4 dark:border-zinc-800">
        <button
          type="button"
          onClick={signOut}
          className="rounded border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          Sign out
        </button>
      </div>
    </section>
  );
}
