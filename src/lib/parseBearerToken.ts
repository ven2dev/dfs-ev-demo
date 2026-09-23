import type { NextRequest } from "next/server";

// Pure header parsing, no Firebase Admin dependency -- deliberately NOT
// server-only-guarded (unlike apiAuth.ts) specifically so it's importable
// by the plain node --test runner. It touches no secrets, so there's
// nothing unsafe about it running in any context.
export const parseBearerToken = (request: NextRequest): string | null => {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice("Bearer ".length);
};
