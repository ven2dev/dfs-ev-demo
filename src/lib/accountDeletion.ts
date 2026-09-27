// Deliberately has zero dependency, even type-only, on anything
// server-only-guarded (apiAuth.ts, firebaseAdmin.ts) -- that's what
// makes performAccountDeletion unit-testable with plain fakes, no
// server-only resolution fighting, no real Firestore/Auth SDK needed.
export type DeletionUidCheck =
  | { status: "active"; uid: string }
  | { status: "already-deleted"; uid: string }
  | { status: "unauthorized" };

export type PerformAccountDeletionResult =
  | { status: "success" }
  | { status: "unauthorized" }
  // The route (not this function) is responsible for both logging
  // `cause` and mapping it to an HTTP response -- keeping that here
  // would swallow the underlying error into a fixed message, losing
  // the observability a real partial-failure state needs.
  | { status: "auth-deletion-failed"; cause: unknown };

export type AccountDeletionDeps = {
  deleteFirestoreDoc: (uid: string) => Promise<void>;
  deleteAuthUser: (uid: string) => Promise<void>;
};

const isUserNotFoundError = (err: unknown): boolean =>
  (err as { code?: string } | null)?.code === "auth/user-not-found";

// Firestore deletion is intentionally left uncaught here: nothing
// destructive has happened yet at that point (Auth is still untouched),
// so it's safe to let a failure propagate and fail generically. Only a
// failure AFTER Firestore has already succeeded is a genuine partial
// state -- that's why only the Auth deletion below is caught and
// reported as its own distinct status.
export const performAccountDeletion = async (
  uidCheck: DeletionUidCheck,
  deps: AccountDeletionDeps
): Promise<PerformAccountDeletionResult> => {
  if (uidCheck.status === "unauthorized") {
    return { status: "unauthorized" };
  }

  await deps.deleteFirestoreDoc(uidCheck.uid);

  if (uidCheck.status === "already-deleted") {
    return { status: "success" };
  }

  try {
    await deps.deleteAuthUser(uidCheck.uid);
  } catch (err) {
    if (isUserNotFoundError(err)) {
      return { status: "success" };
    }
    return { status: "auth-deletion-failed", cause: err };
  }

  return { status: "success" };
};
