import "server-only";

import { getApp, getApps, initializeApp, cert, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { getAuth, type Auth } from "firebase-admin/auth";

// Unlike firebaseClient.ts's getFirebaseAuth(), this never runs during
// prerendering or in the browser -- only inside API route handlers, at
// request time. A missing/invalid credential here is a genuine server
// misconfiguration, not something to degrade around: it throws, and each
// route's own try/catch turns that into a controlled 500 instead of a
// silent bad state.
let cachedApp: App | undefined;

const getAdminApp = (): App => {
  if (cachedApp) return cachedApp;
  if (getApps().length) {
    cachedApp = getApp();
    return cachedApp;
  }

  const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_KEY_BASE64;
  if (!encoded) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_KEY_BASE64 is not set -- Admin SDK cannot initialize"
    );
  }

  const serviceAccount = JSON.parse(Buffer.from(encoded, "base64").toString("utf-8"));
  cachedApp = initializeApp({ credential: cert(serviceAccount) });
  return cachedApp;
};

export const getFirestoreDb = (): Firestore => getFirestore(getAdminApp());

export const getAdminAuth = (): Auth => getAuth(getAdminApp());
