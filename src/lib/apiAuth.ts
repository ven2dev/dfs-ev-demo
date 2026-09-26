import "server-only";

import type { NextRequest } from "next/server";
import { getAdminAuth } from "./firebaseAdmin";
import { parseBearerToken } from "./parseBearerToken";

type RevocationCheckResult =
  | { status: "ok"; uid: string }
  // The ONLY code that means the account record no longer exists at
  // all -- distinct from auth/id-token-revoked (revokeRefreshTokens,
  // account still exists) and auth/user-disabled (account exists, just
  // disabled). Conflating any of these would let a revoked or disabled
  // account's still-cryptographically-valid token be treated as
  // "already deleted" by callers that check for that specifically.
  | { status: "user-not-found" }
  | { status: "invalid" };

const verifyWithRevocationCheck = async (
  token: string
): Promise<RevocationCheckResult> => {
  const auth = getAdminAuth();
  try {
    // The `true` (checkRevoked) argument matters: a Firebase ID token
    // stays cryptographically valid for up to an hour regardless of
    // what happens to the account server-side. Without this, a stale
    // token from an account deleted moments ago would still verify
    // successfully -- decoded.uid would resolve to a uid with no
    // corresponding Auth record, and a write route would happily
    // create a fresh Firestore document for it, orphaned data no
    // future sign-in could ever reach again.
    const decoded = await auth.verifyIdToken(token, true);
    return { status: "ok", uid: decoded.uid };
  } catch (err) {
    if ((err as { code?: string }).code === "auth/user-not-found") {
      return { status: "user-not-found" };
    }
    return { status: "invalid" };
  }
};

// Never trust a client-supplied uid in a request body -- this is the one
// place a uid is allowed to enter the system, and it only ever comes from
// a verified ID token.
//
// getAdminAuth() failures (a missing/invalid service account key) throw
// out of verifyWithRevocationCheck's own try, not this function -- that's
// a server misconfiguration, not an invalid caller credential, and must
// not be swallowed into the same "return null" -> 401 path as a
// genuinely bad token. Callers should invoke this from inside their own
// try/catch so that failure surfaces as a 500, not a misleading
// "Unauthorized" for a perfectly valid signed-in user.
export const requireUid = async (request: NextRequest): Promise<string | null> => {
  const token = parseBearerToken(request);
  if (!token) return null;

  const result = await verifyWithRevocationCheck(token);
  return result.status === "ok" ? result.uid : null;
};

export type DeletionUidCheck =
  | { status: "active"; uid: string }
  | { status: "already-deleted"; uid: string }
  | { status: "unauthorized" };

// Used only by DELETE /api/account. A retry of an already-completed
// deletion looks exactly like this: the first attempt's response was
// lost, so the client retried, but by then requireUid's own checkRevoked
// lookup fails since there's no account left to check -- a plain 401
// would incorrectly tell the client an operation that already finished
// needs to be attempted again. This distinguishes that specific case
// from every other reason a token could fail verification (revoked,
// disabled, expired, malformed) by checking for the exact
// auth/user-not-found code, not just "the token still looks otherwise
// valid" -- the earlier version of this function made that mistake,
// which would have reported false success for a merely revoked or
// disabled account instead of a genuinely deleted one.
export const checkUidForDeletion = async (
  request: NextRequest
): Promise<DeletionUidCheck> => {
  const token = parseBearerToken(request);
  if (!token) return { status: "unauthorized" };

  const result = await verifyWithRevocationCheck(token);
  if (result.status === "ok") return { status: "active", uid: result.uid };
  if (result.status === "invalid") return { status: "unauthorized" };

  // result.status === "user-not-found": the account genuinely no
  // longer exists. Re-verify signature/expiry only (still a real
  // cryptographic check, just without the network lookup that just
  // failed) to recover which uid this otherwise-valid token names.
  const auth = getAdminAuth();
  try {
    const decoded = await auth.verifyIdToken(token, false);
    return { status: "already-deleted", uid: decoded.uid };
  } catch {
    return { status: "unauthorized" };
  }
};
