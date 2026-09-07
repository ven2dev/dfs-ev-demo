"use client";

import { useConnectionStatus } from "./hooks";
import { useHasHydrated } from "./useHasHydrated";
import { useInitAuth } from "./useInitAuth";

// Forces the store to initialize client-side (so it's instantiated and
// visible in Redux DevTools) ahead of Phase 2/4 building real consumers.
export function StoreBootstrap() {
  useHasHydrated();
  useConnectionStatus();
  useInitAuth();

  return null;
}
