"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { getAuthHeaders } from "@/lib/authHeaders";
import { useAuthStatus, useDisplayName, useProviderId } from "@/store/hooks";
import { useSignOut } from "@/store/useSignOut";

// Firebase's raw providerId format ("google.com") isn't what a user
// should see -- Google-only for now, but a lookup rather than a
// hardcoded literal so a second provider just adds an entry here.
const PROVIDER_LABELS: Record<string, string> = {
  "google.com": "Google",
};

const DELETE_CONFIRM_TEXT = "DELETE";

export default function AccountPage() {
  const authStatus = useAuthStatus();
  const displayName = useDisplayName();
  const providerId = useProviderId();
  const signOut = useSignOut();
  const router = useRouter();

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const cancelDelete = () => {
    setShowDeleteConfirm(false);
    setConfirmText("");
    setDeleteError(null);
  };

  const handleDeleteAccount = async () => {
    if (confirmText !== DELETE_CONFIRM_TEXT || deleting) return;
    setDeleting(true);
    setDeleteError(null);

    try {
      const res = await fetch("/api/account", {
        method: "DELETE",
        headers: await getAuthHeaders(),
      });
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.reason ?? "Unknown failure");
      }
      // signOut() drives the exact same onAuthStateChanged -> setUser(null)
      // -> syncDataFromServer(null) chain a normal sign-out already goes
      // through elsewhere in the app -- that already resets goal/
      // watchlist/matchupConfig cleanly, so a client-side route push is
      // enough here; no need for a full reload just because this sign-out
      // happens to follow a deletion.
      signOut();
      router.push("/");
    } catch (err) {
      setDeleteError(`Failed to delete account: ${(err as Error).message}`);
      setDeleting(false);
    }
  };

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

      <div className="mt-6 border-t border-zinc-200 pt-4 dark:border-zinc-800">
        {!showDeleteConfirm ? (
          <button
            type="button"
            onClick={() => setShowDeleteConfirm(true)}
            className="text-sm text-red-600 hover:underline"
          >
            Delete account
          </button>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-red-600">
              This permanently deletes your account and all saved data. This
              cannot be undone.
            </p>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Type <strong className="font-mono">{DELETE_CONFIRM_TEXT}</strong>{" "}
              to confirm.
            </p>
            <input
              type="text"
              value={confirmText}
              onChange={(event) => setConfirmText(event.target.value)}
              disabled={deleting}
              placeholder={DELETE_CONFIRM_TEXT}
              className="w-full rounded border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleDeleteAccount}
                disabled={confirmText !== DELETE_CONFIRM_TEXT || deleting}
                className="rounded bg-red-600 px-3 py-1.5 text-sm text-white disabled:opacity-50"
              >
                {deleting ? "Deleting…" : "Permanently delete my account"}
              </button>
              <button
                type="button"
                onClick={cancelDelete}
                disabled={deleting}
                className="rounded border border-zinc-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-zinc-700"
              >
                Cancel
              </button>
            </div>
            {deleteError && <p className="text-sm text-red-600">{deleteError}</p>}
          </div>
        )}
      </div>
    </section>
  );
}
