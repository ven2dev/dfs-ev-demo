import "server-only";

import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { getAuth, type Auth } from "firebase-admin/auth";
import { ConfigurationError, serverConfig, sanitizedFailure } from "./config.server";

// Unlike firebaseClient.ts's getFirebaseAuth(), this never runs during
// prerendering or in the browser -- only inside API route handlers, at
// request time. A missing/invalid credential here is a genuine server
// misconfiguration, not something to degrade around: it throws, and each
// route's own try/catch turns that into a controlled 500 instead of a
// silent bad state.
// Reloads can retain the SDK's named app after the boundary cache is replaced.
// Verify its explicit project identity after validating the current account.
const getAdminApp = () => serverConfig.firebaseApp(account => {
  const existing = getApps().find(app => app.name === "dfs-ev-server");
  if (existing) {
    if (existing.options.projectId !== account.projectId) {
      throw new ConfigurationError("firebase-project-mismatch");
    }
    return existing;
  }
  return initializeApp({ projectId: account.projectId, credential: cert(account) }, "dfs-ev-server");
});

export const getFirestoreDb = (): Firestore => {
  try { return getFirestore(getAdminApp()); }
  catch (error) { throw sanitizedFailure(error); }
};

export const getAdminAuth = (): Auth => {
  try { return getAuth(getAdminApp()); }
  catch (error) { throw sanitizedFailure(error); }
};
