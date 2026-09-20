import "server-only";

import type { NextRequest } from "next/server";
import { getAdminAuth } from "./firebaseAdmin";

// Never trust a client-supplied uid in a request body -- this is the one
// place a uid is allowed to enter the system, and it only ever comes from
// a verified ID token.
export const requireUid = async (request: NextRequest): Promise<string | null> => {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;

  const token = authHeader.slice("Bearer ".length);
  try {
    const decoded = await getAdminAuth().verifyIdToken(token);
    return decoded.uid;
  } catch {
    return null;
  }
};
