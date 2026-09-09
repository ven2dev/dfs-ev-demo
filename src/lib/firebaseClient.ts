import { getApp, getApps, initializeApp } from "firebase/app";
import { GoogleAuthProvider, getAuth, type Auth } from "firebase/auth";

// getApps().length check avoids "app already exists" during Next.js
// hot-reload, which re-executes this module without a fresh page load.
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

// undefined = not yet attempted, null = attempted and failed (don't
// retry/re-log every call), Auth = succeeded.
let cachedAuth: Auth | null | undefined;

// Firebase Auth needs a real browser (window, IndexedDB) to do anything
// useful -- there's no reason for it to initialize during Next.js's
// server-side prerendering, and doing so means a missing/invalid config
// crashes the entire build instead of just the auth feature. Deferring
// this to first real use in the browser sidesteps that class of failure
// rather than trying to catch it after the fact.
//
// Returns null (rather than throwing) if config is missing/invalid --
// NEXT_PUBLIC_ values are baked into the bundle at build time, so this
// can't be recovered by setting env vars on an already-built artifact,
// only by rebuilding. Every caller needs to handle that possibility and
// degrade accordingly; centralizing the try/catch here means each
// caller just null-checks instead of duplicating that handling.
export function getFirebaseAuth(): Auth | null {
  if (typeof window === "undefined") {
    throw new Error("getFirebaseAuth() called outside the browser");
  }
  if (cachedAuth !== undefined) return cachedAuth;
  try {
    const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
    cachedAuth = getAuth(app);
  } catch (err) {
    console.error("[firebaseClient] Firebase Auth failed to initialize:", err);
    cachedAuth = null;
  }
  return cachedAuth;
}

export const googleProvider = new GoogleAuthProvider();
