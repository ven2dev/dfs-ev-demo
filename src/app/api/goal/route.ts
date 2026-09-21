import { NextRequest, NextResponse } from "next/server";
import { getFirestoreDb } from "@/lib/firebaseAdmin";
import { requireUid } from "@/lib/apiAuth";
import type { Goal } from "@/types";

// Whole-field replace, not a merge into goal's own sub-fields -- goal
// changes as one complete object on the client (setGoal), never as a
// partial patch, so the write here mirrors that.
export const PUT = async (request: NextRequest) => {
  const uid = await requireUid(request);
  if (!uid) {
    return NextResponse.json({ success: false, reason: "Unauthorized" }, { status: 401 });
  }

  try {
    const goal: Goal | null = await request.json();
    await getFirestoreDb().collection("users").doc(uid).set({ goal }, { merge: true });
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[api/goal] PUT failed:", err);
    return NextResponse.json({ success: false, reason: "Internal error" }, { status: 500 });
  }
};
