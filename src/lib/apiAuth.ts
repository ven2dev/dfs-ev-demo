import "server-only";

import type { NextRequest } from "next/server";
import { getAdminAuth } from "./firebaseAdmin";
import { parseBearerToken } from "./parseBearerToken";

// Never trust a client-supplied uid in a request body -- this is the one
// place a uid is allowed to enter the system, and it only ever comes from
// a verified ID token.
export const requireUid = async (request: NextRequest): Promise<string | null> => {
  const token = parseBearerToken(request);
  if (!token) return null;

  // getAdminAuth() is called OUTSIDE this try -- if the Admin SDK itself
  // fails to initialize (e.g. a missing/invalid service account key),
  // that's a server misconfiguration, not an invalid caller credential,
  // and must not be swallowed into the same "return null" -> 401 path as
  // a genuinely bad token. Callers should invoke this from inside their
  // own try/catch so that failure surfaces as a 500, not a misleading
  // "Unauthorized" for a perfectly valid signed-in user.
  const auth = getAdminAuth();
  try {
    // The `true` (checkRevoked) argument matters: a Firebase ID token
    // stays cryptographically valid for up to an hour regardless of
    // what happens to the account server-side. Without this, a stale
    // token from an account deleted moments ago would still verify
    // successfully -- decoded.uid would resolve to a uid with no
    // corresponding Auth record, and a write route would happily
    // create a fresh Firestore document for it, orphaned data no
    // future sign-in could ever reach again. This internally looks the
    // user up to check revocation status, which itself fails for a
    // fully-deleted user -- catching both "token revoked" and "account
    // deleted entirely" in one check.
    const decoded = await auth.verifyIdToken(token, true);
    return decoded.uid;
  } catch {
    return null;
  }
};
