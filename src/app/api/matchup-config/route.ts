import { NextRequest, NextResponse } from "next/server";
import { getFirestoreDb } from "@/lib/firebaseAdmin";
import { requireUid } from "@/lib/apiAuth";
import type { MatchupConfig } from "@/types";

// Whole-field replace, same reasoning as /api/goal -- matchupConfig is
// set as one complete object client-side (setMatchupConfig), never
// patched field-by-field.
export const PUT = async (request: NextRequest) => {
  const uid = await requireUid(request);
  if (!uid) {
    return NextResponse.json({ success: false, reason: "Unauthorized" }, { status: 401 });
  }

  try {
    const matchupConfig: MatchupConfig = await request.json();
    await getFirestoreDb().collection("users").doc(uid).set({ matchupConfig }, { merge: true });
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[api/matchup-config] PUT failed:", err);
    return NextResponse.json({ success: false, reason: "Internal error" }, { status: 500 });
  }
};
