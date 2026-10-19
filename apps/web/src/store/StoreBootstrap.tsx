"use client";

import { useConnectionStatus } from "./hooks";
import { useInitAuth } from "./useInitAuth";

// Forces the store to initialize client-side (so it's instantiated and
// visible in Redux DevTools) ahead of Phase 2/4 building real consumers.
export const StoreBootstrap = () => {
  useConnectionStatus();
  useInitAuth();

  return null;
};
