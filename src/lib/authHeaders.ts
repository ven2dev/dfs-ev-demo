import { getFirebaseAuth } from "./firebaseClient";

// Shared by every client call into an authenticated route (watchlist,
// matchup-config, and eventually goal once Phase 10 gives it a real
// caller) -- avoids each call site re-deriving the same token-fetch logic.
export const getAuthHeaders = async (): Promise<HeadersInit> => {
  const idToken = await getFirebaseAuth()?.currentUser?.getIdToken();
  return idToken ? { Authorization: `Bearer ${idToken}` } : {};
};
