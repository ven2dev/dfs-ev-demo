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

let cachedAuth: Auth | undefined;

// Firebase Auth needs a real browser (window, IndexedDB) to do anything
// useful -- there's no reason for it to initialize during Next.js's
// server-side prerendering, and doing so means a missing/invalid config
// crashes the entire build instead of just the auth feature. Deferring
// this to first real use in the browser sidesteps that class of failure
// rather than trying to catch it after the fact.
export function getFirebaseAuth(): Auth {
  if (typeof window === "undefined") {
    throw new Error("getFirebaseAuth() called outside the browser");
  }
  if (!cachedAuth) {
    const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
    cachedAuth = getAuth(app);
  }
  return cachedAuth;
}

export const googleProvider = new GoogleAuthProvider();
