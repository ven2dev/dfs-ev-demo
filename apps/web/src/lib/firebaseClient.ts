import { getApp, getApps, initializeApp } from "firebase/app";
import { GoogleAuthProvider, getAuth, type Auth } from "firebase/auth";
import { publicConfig } from "./config.client";

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
  if (cachedAuth === null) return null;
  try {
    const options = publicConfig.firebaseAuth(cachedAuth?.app.options);
    if (cachedAuth) return cachedAuth;
    // Preserve the default app's Auth persistence key and hot-reload behavior,
    // but verify any existing app before asking it for an Auth client.
    const app = getApps().length ? getApp() : initializeApp(options);
    publicConfig.firebaseAuth(app.options);
    cachedAuth = getAuth(app);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error &&
      typeof error.code === "string" && error.code.match(/^[a-z-]+\/[a-z0-9-]+$/)?.[0] === error.code ? error.code : undefined;
    console.error("[firebaseClient] Firebase Auth failed to initialize:", "Browser configuration unavailable.", ...(code ? [{ code }] : []));
    cachedAuth = null;
  }
  return cachedAuth;
}

export const googleProvider = new GoogleAuthProvider();
